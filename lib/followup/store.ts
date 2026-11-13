// Ticket 040 FR-2 / FR-6: stored follow-up questions (server only). The 30-questions-per-day limit is atomic: the
// guardian's rows are counted and a reservation row inserted under a per-guardian advisory lock (013's pattern:
// a reservation is a row with an empty answer; real answers are never empty).
import type postgres from "postgres";
import { pg, type Queryable, type Sql } from "@/lib/pg";
import { DAILY_QUESTION_LIMIT, FollowupCitationSchema, SAFETY_KINDS, type FollowupAnswer, type FollowupChannel, type FollowupHistoryItem } from "./constants";

// Reservations older than this belong to a crashed request (routes stop after 60 s) and are cleared.
const STALE_RESERVATION = "5 minutes";

export type Reservation = { ok: true; id: string } | { ok: false; reason: "limit" };

export async function reserveQuestion(
  input: { guardianUserId: string; childId: string; question: string; channel: FollowupChannel; limit?: number },
  sql?: Sql,
): Promise<Reservation> {
  const db = sql ?? (await pg());
  const limit = input.limit ?? DAILY_QUESTION_LIMIT;
  return db.begin(async (tx): Promise<Reservation> => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${`followup:${input.guardianUserId}`}, 40))`;
    await tx`
      delete from public.followup_questions
      where guardian_user_id = ${input.guardianUserId} and answer = ''
        and created_at < now() - ${STALE_RESERVATION}::interval`;
    const [{ n }] = await tx<{ n: number }[]>`
      select count(*)::int as n from public.followup_questions
      where guardian_user_id = ${input.guardianUserId} and created_at > now() - interval '24 hours'`;
    if (n >= limit) return { ok: false, reason: "limit" };
    const [row] = await tx<{ id: string }[]>`
      insert into public.followup_questions (child_id, guardian_user_id, question, channel)
      values (${input.childId}, ${input.guardianUserId}, ${input.question}, ${input.channel})
      returning id`;
    return { ok: true, id: row.id };
  });
}

export async function completeQuestion(id: string, answer: FollowupAnswer, sql?: Queryable): Promise<boolean> {
  const db = sql ?? (await pg());
  const rows = await db`
    update public.followup_questions
    set answer = ${answer.answer}, found = ${answer.found}, safety = ${answer.safety ?? null},
        citations = ${db.json(answer.citations as unknown as postgres.JSONValue)}
    where id = ${id} and answer = ''
    returning id`;
  return rows.length > 0;
}

/** Frees a reservation after a failed generation (consent withdrawn, model error); answered rows stay. */
export async function releaseQuestion(id: string, sql?: Queryable): Promise<void> {
  const db = sql ?? (await pg());
  await db`delete from public.followup_questions where id = ${id} and answer = ''`;
}

/** FR-6: the asking guardian's own history for one child, newest first. Other guardians' questions never appear. */
export async function listHistory(guardianUserId: string, childId: string, limit = 50): Promise<FollowupHistoryItem[]> {
  const db = await pg();
  const rows = await db<
    { id: string; question: string; answer: string; found: boolean; citations: unknown; safety: string | null; channel: "text" | "voice"; created_at: Date }[]
  >`
    select id, question, answer, found, citations, safety, channel, created_at from public.followup_questions
    where guardian_user_id = ${guardianUserId} and child_id = ${childId} and answer <> ''
    order by created_at desc limit ${limit}`;
  return rows.map((r) => {
    const citations = FollowupCitationSchema.array().safeParse(r.citations);
    const safety = (SAFETY_KINDS as readonly string[]).includes(r.safety ?? "") ? (r.safety as FollowupAnswer["safety"]) : undefined;
    return {
      id: r.id,
      question: r.question,
      answer: r.answer,
      found: r.found,
      citations: citations.success ? citations.data : [],
      ...(safety ? { safety } : {}),
      channel: r.channel,
      created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    };
  });
}

/** Questions the guardian asked in the last 24 hours (all children, reservations included). */
export async function questionsUsed(guardianUserId: string): Promise<number> {
  const db = await pg();
  const [{ n }] = await db<{ n: number }[]>`
    select count(*)::int as n from public.followup_questions
    where guardian_user_id = ${guardianUserId} and created_at > now() - interval '24 hours'`;
  return n;
}
