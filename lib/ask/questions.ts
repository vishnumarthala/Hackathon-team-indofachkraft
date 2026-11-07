// Stored questions of a referral and the atomic 50-question limit (ticket 013, FR-4). Server only.
import postgres, { type Sql } from "postgres";
import { supabaseAdmin } from "@/lib/db";
import { env } from "@/lib/env";
import { ResolvedCitationSchema, type AskResult } from "@/lib/ask/citations";

export const QUESTION_LIMIT = 50;
// A reservation is a case_questions row with an empty answer (real answers are never empty). Reservations
// older than this belong to a crashed request (routes stop after 60 s) and are cleared.
const STALE_RESERVATION = "5 minutes";

export type StoredQuestion = AskResult & { id: string; question: string; created_at: string };

const globalDb = globalThis as typeof globalThis & { __carethreadAskSql?: Sql };

export function askDb(): Sql {
  if (typeof window !== "undefined") throw new Error("lib/ask/questions.ts is server-only");
  globalDb.__carethreadAskSql ??= postgres(env.DATABASE_URL, {
    max: 3,
    prepare: false,
    idle_timeout: 20,
    onnotice: () => {},
  });
  return globalDb.__carethreadAskSql;
}

export type Reservation = { ok: true; questionId: string } | { ok: false; reason: "not_found" | "limit" };

/**
 * Locks the referral row, so concurrent requests for one referral count one after another, then
 * reserves a slot by inserting a placeholder row. Revoked or deleted referrals get `not_found`.
 */
export async function reserveQuestion(referralId: string, question: string, sql: Sql = askDb()): Promise<Reservation> {
  return sql.begin(async (tx): Promise<Reservation> => {
    const [referral] = await tx<{ status: string }[]>`
      select status from referrals where id = ${referralId} for update`;
    if (!referral || referral.status === "revoked") return { ok: false, reason: "not_found" };
    await tx`
      delete from case_questions
      where referral_id = ${referralId} and answer = ''
        and created_at < now() - ${STALE_RESERVATION}::interval`;
    const [{ n }] = await tx<{ n: number }[]>`
      select count(*)::int as n from case_questions where referral_id = ${referralId}`;
    if (n >= QUESTION_LIMIT) return { ok: false, reason: "limit" };
    const [row] = await tx<{ id: string }[]>`
      insert into case_questions (referral_id, question, answer, found, citations)
      values (${referralId}, ${question}, '', false, '[]'::jsonb)
      returning id`;
    return { ok: true, questionId: row.id };
  });
}

export async function completeQuestion(questionId: string, result: AskResult, sql: Sql = askDb()): Promise<boolean> {
  const rows = await sql`
    update case_questions
    set answer = ${result.answer}, found = ${result.found},
        citations = ${sql.json(result.citations as unknown as postgres.JSONValue)}
    where id = ${questionId} and answer = ''
    returning id`;
  return rows.length > 0;
}

/** Frees a reservation after a failed generation; answered questions are never removed. */
export async function releaseQuestion(questionId: string, sql: Sql = askDb()): Promise<void> {
  await sql`delete from case_questions where id = ${questionId} and answer = ''`;
}

/** Answered questions of a referral, oldest first (reservations in progress are hidden). */
export async function listQuestions(referralId: string): Promise<StoredQuestion[]> {
  const { data, error } = await supabaseAdmin()
    .from("case_questions")
    .select("id, question, answer, found, citations, created_at")
    .eq("referral_id", referralId)
    .neq("answer", "")
    .order("created_at", { ascending: true });
  if (error) throw new Error(`Could not load questions: ${error.message}`);
  return (data ?? []).map((row) => {
    const citations = ResolvedCitationSchema.array().safeParse(row.citations);
    return {
      id: row.id as string,
      question: row.question as string,
      answer: row.answer as string,
      found: row.found as boolean,
      citations: citations.success ? citations.data : [],
      created_at: row.created_at as string,
    };
  });
}
