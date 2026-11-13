// Ticket 033: server-side store for public check-in sessions (`screen_sessions`). Server only.
// Every write is a single row lock + update in one transaction (`select ... for update`), so concurrent answers,
// a red flag and `finish` cannot interleave. Expiry is decided by the database clock. Anonymous actions write no
// audit rows: an audit row would attach a hashed IP to the session (FR-5: no IP).
// 048: the session also stores its instrument (ISAA-derived or M-CHAT-R/F, fixed at the start) and the parent's
// worries (codes); results carry the provider-type recommendation (lib/screen/recommend.ts).
import { auditStrict } from "@/lib/audit";
import { isUuid } from "@/lib/cases/validation";
import { score } from "@/lib/clinical/instruments";
import type { CheckinBand, RedFlagCode } from "@/lib/clinical/checkin";
import { pg, type Queryable } from "@/lib/pg";
import {
  answeredRedFlags,
  domainLevel,
  followUpQuestions,
  isValidScreenAnswer,
  mchatBand,
  missingScreenItems,
  redFlagCodeForItem,
  redFlagResult,
  screenQuestions,
  type QuestionAgeBand,
  type ScreenConcern,
  type ScreenInstrument,
  type ScreenMode,
  type ScreenQuestion,
  type ScreenResult,
  type StoredAgeBand,
} from "./questions";
import { recommend } from "./recommend";

if (typeof window !== "undefined") {
  throw new Error("lib/screen/store.ts is server-only");
}

export const NOT_FOUND = "Check-in not found";
export const EXPIRED = "This check-in has expired. Please start a new one.";
export const STOPPED = "This check-in was stopped";
export const FINISHED = "This check-in is already finished";
export const INCOMPLETE = "Please answer every question";
export const NOT_SAVABLE = "Only a finished check-in can be saved";
export const ALREADY_SAVED = "This check-in is already saved to another child";
export const NO_FOLLOW_UP = "This check-in has no follow-up questions";

export type ScreenRow = {
  id: string;
  created_at: Date;
  expires_at: Date;
  age_band: StoredAgeBand;
  mode: ScreenMode;
  answers: Record<string, string>;
  result_band: CheckinBand | null;
  red_flag_codes: RedFlagCode[];
  conversation_id: string | null;
  saved_child_id: string | null;
  saved_by: string | null;
  instrument: ScreenInstrument;
  concerns: ScreenConcern[];
};

type Locked = ScreenRow & { expired: boolean };

export type Failure = { ok: false; status: number; error: string; details?: unknown };
const failure = (status: number, error: string, details?: unknown): Failure => ({ ok: false, status, error, details });

export type SessionStatus = "open" | "stopped" | "finished";

export function sessionStatus(row: Pick<ScreenRow, "result_band" | "red_flag_codes">): SessionStatus {
  if (row.red_flag_codes.length > 0) return "stopped";
  if (row.result_band) return "finished";
  return "open";
}

export async function createScreenSession(
  ageBand: QuestionAgeBand,
  mode: ScreenMode,
  opts: { instrument?: ScreenInstrument; concerns?: readonly ScreenConcern[] } = {},
): Promise<{ id: string; expires_at: Date }> {
  const sql = await pg();
  const [row] = await sql<{ id: string; expires_at: Date }[]>`
    insert into public.screen_sessions (age_band, mode, instrument, concerns)
    values (${ageBand}, ${mode}, ${opts.instrument ?? "ISAA_PARENT_CHECKIN"}, ${[...(opts.concerns ?? [])]}::text[])
    returning id, expires_at`;
  return row;
}

async function lock(tx: Queryable, id: string): Promise<Locked | null> {
  if (!isUuid(id)) return null;
  const [row] = await tx<Locked[]>`
    select *, expires_at <= now() as expired from public.screen_sessions where id = ${id} for update`;
  return row ?? null;
}

async function find(sql: Queryable, id: string): Promise<Locked | null> {
  if (!isUuid(id)) return null;
  const [row] = await sql<Locked[]>`select *, expires_at <= now() as expired from public.screen_sessions where id = ${id}`;
  return row ?? null;
}

/** Anonymous endpoints: saved check-ins belong to a child now and are no longer reachable by session id. */
function gate(row: Locked | null, { allowClosed = false } = {}): Failure | null {
  if (!row || row.saved_child_id) return failure(404, NOT_FOUND);
  if (row.expired) return failure(410, EXPIRED);
  if (allowClosed) return null;
  const status = sessionStatus(row);
  if (status === "stopped") return failure(409, STOPPED);
  if (status === "finished") return failure(409, FINISHED);
  return null;
}

/** Sets the ElevenLabs conversation id once, for voice sessions only. */
function conversationFragment(tx: Queryable, conversationId: string | undefined) {
  return conversationId
    ? tx`conversation_id = coalesce(conversation_id, case when mode = 'voice' then ${conversationId} end)`
    : tx`conversation_id = conversation_id`;
}

export type AnswerOutcome = { ok: true; missing: string[]; stop: boolean };

/** FR-4 answers: merged into the session; a red-flag question answered `yes` stops the check-in (FR-7). */
export async function recordAnswers(
  id: string,
  answers: { item_id: string; answer: string }[],
  conversationId?: string,
): Promise<AnswerOutcome | Failure> {
  const sql = await pg();
  return sql.begin(async (tx) => {
    const row = await lock(tx, id);
    const denied = gate(row);
    if (denied || !row) return denied ?? failure(404, NOT_FOUND);
    const questions = screenQuestions(row.age_band, row.instrument);
    const bad = answers.find((a) => !isValidScreenAnswer(questions, a.item_id, a.answer));
    if (bad) return failure(400, "Invalid request", { answers: `Unknown question or answer: ${bad.item_id}` });
    const merged: Record<string, string> = { ...row.answers };
    for (const a of answers) merged[a.item_id] = a.answer;
    const codes = answers
      .filter((a) => a.answer === "yes")
      .map((a) => redFlagCodeForItem(a.item_id))
      .filter((c): c is RedFlagCode => c !== null);
    await tx`
      update public.screen_sessions
      set answers = ${tx.json(merged)},
          red_flag_codes = (select coalesce(array_agg(distinct c order by c), '{}') from unnest(red_flag_codes || ${codes}::text[]) c),
          ${conversationFragment(tx, conversationId)}
      where id = ${row.id}`;
    return { ok: true as const, missing: missingScreenItems(questions, merged), stop: codes.length > 0 };
  });
}

/** FR-4 / FR-7: a red flag reported by the agent (or the form): stored, and the check-in stops. Idempotent. */
export async function recordRedFlag(id: string, code: RedFlagCode, conversationId?: string): Promise<{ ok: true } | Failure> {
  const sql = await pg();
  return sql.begin(async (tx) => {
    const row = await lock(tx, id);
    const denied = gate(row, { allowClosed: true });
    if (denied || !row) return denied ?? failure(404, NOT_FOUND);
    if (sessionStatus(row) === "finished") return failure(409, FINISHED);
    await tx`
      update public.screen_sessions
      set red_flag_codes = (select array_agg(distinct c order by c) from unnest(red_flag_codes || ${[code]}::text[]) c),
          ${conversationFragment(tx, conversationId)}
      where id = ${row.id}`;
    return { ok: true as const };
  });
}

/**
 * Result computed from stored answers with 024's `score(...)` for the session's instrument: ISAA-derived bands and
 * domains, or (048) the M-CHAT-R/F risk after the optional Follow-Up. Red flags override everything (048 FR-8).
 */
export function resultOf(row: Pick<ScreenRow, "answers" | "red_flag_codes" | "age_band" | "instrument" | "concerns">): ScreenResult {
  const instrument = row.instrument ?? "ISAA_PARENT_CHECKIN";
  if (row.red_flag_codes.length > 0 || answeredRedFlags(row.answers).length > 0) return redFlagResult(instrument);
  const concerns = row.concerns ?? [];
  if (instrument === "MCHAT_RF") {
    const { result } = score("MCHAT_RF", row.answers);
    if (!result.risk || !result.result_text) throw new Error("Check-in is incomplete");
    const band = mchatBand(result.risk, result.follow_up.result);
    return {
      result_band: band,
      domains: [],
      red_flag: false,
      message: result.result_text,
      instrument,
      mchat: {
        risk: result.risk,
        follow_up: {
          offered: result.follow_up.offered,
          result: result.follow_up.result,
          questions: result.follow_up.result ? [] : followUpQuestions(instrument, row.answers),
        },
      },
      recommendation: recommend({ ageBand: row.age_band, concerns, resultBand: band }),
    };
  }
  const { result } = score("ISAA_PARENT_CHECKIN", row.answers);
  if (result.red_flags.length > 0) return redFlagResult(instrument);
  if (!result.band || !result.result_text) throw new Error("Check-in is incomplete");
  return {
    result_band: result.band,
    domains: result.by_domain.map((d) => ({ domain: d.domain, level: domainLevel(d) })),
    red_flag: false,
    message: result.result_text,
    instrument,
    mchat: null,
    recommendation: recommend({ ageBand: row.age_band, concerns, resultBand: result.band }),
  };
}

/** FR-4 finish: band computed server-side. Idempotent: finishing again returns the stored result. */
export async function finishSession(id: string, conversationId?: string): Promise<{ ok: true; result: ScreenResult } | Failure> {
  const sql = await pg();
  return sql.begin(async (tx) => {
    const row = await lock(tx, id);
    const denied = gate(row, { allowClosed: true });
    if (denied || !row) return denied ?? failure(404, NOT_FOUND);
    if (conversationId) await tx`update public.screen_sessions set ${conversationFragment(tx, conversationId)} where id = ${row.id}`;
    if (sessionStatus(row) === "stopped") return { ok: true as const, result: redFlagResult(row.instrument) };
    const missing = missingScreenItems(screenQuestions(row.age_band, row.instrument), row.answers);
    if (missing.length > 0) return failure(422, INCOMPLETE, { missing });
    const result = resultOf(row);
    await tx`update public.screen_sessions set result_band = ${result.result_band} where id = ${row.id}`;
    return { ok: true as const, result };
  });
}

/**
 * 048 FR-3: the optional M-CHAT-R/F Follow-Up of a finished, moderate check-in: every followed-up item gets pass/fail
 * in one request, then the result (and the stored band) is recomputed. Not for saved, stopped or other check-ins.
 */
export async function recordFollowUp(
  id: string,
  answers: { item_id: string; answer: string }[],
): Promise<{ ok: true; result: ScreenResult } | Failure> {
  const sql = await pg();
  return sql.begin(async (tx) => {
    const row = await lock(tx, id);
    const denied = gate(row, { allowClosed: true });
    if (denied || !row) return denied ?? failure(404, NOT_FOUND);
    const status = sessionStatus(row);
    if (status === "stopped") return failure(409, STOPPED);
    if (status !== "finished") return failure(409, INCOMPLETE);
    const current = resultOf(row);
    const questions = current.mchat?.follow_up.questions ?? [];
    if (!current.mchat?.follow_up.offered) return failure(409, NO_FOLLOW_UP);
    if (current.mchat.follow_up.result) return { ok: true as const, result: current };
    const bad = answers.find((a) => !isValidScreenAnswer(questions, a.item_id, a.answer));
    if (bad) return failure(400, "Invalid request", { answers: `Unknown follow-up item or answer: ${bad.item_id}` });
    const merged: Record<string, string> = { ...row.answers };
    for (const a of answers) merged[a.item_id] = a.answer;
    const missing = missingScreenItems(questions, merged);
    if (missing.length > 0) return failure(422, INCOMPLETE, { missing });
    const result = resultOf({ ...row, answers: merged });
    await tx`update public.screen_sessions set answers = ${tx.json(merged)}, result_band = ${result.result_band} where id = ${row.id}`;
    return { ok: true as const, result };
  });
}

export type SessionView = {
  session_id: string;
  age_band: StoredAgeBand;
  mode: ScreenMode;
  instrument: ScreenInstrument;
  concerns: ScreenConcern[];
  status: SessionStatus;
  expires_at: string;
  questions: ScreenQuestion[];
  answers: Record<string, string>;
  result: ScreenResult | null;
};

/** GET /api/screen/sessions/:id: resume after a reload or after signing in to save (open/finished only). */
export async function getSessionView(id: string): Promise<{ ok: true; view: SessionView } | Failure> {
  const sql = await pg();
  const row = await find(sql, id);
  const denied = gate(row, { allowClosed: true });
  if (denied || !row) return denied ?? failure(404, NOT_FOUND);
  const status = sessionStatus(row);
  return {
    ok: true,
    view: {
      session_id: row.id,
      age_band: row.age_band,
      mode: row.mode,
      instrument: row.instrument,
      concerns: row.concerns,
      status,
      expires_at: row.expires_at.toISOString(),
      questions: screenQuestions(row.age_band, row.instrument),
      answers: row.answers,
      result: status === "open" ? null : resultOf(row),
    },
  };
}

/**
 * FR-8: attaches a finished check-in to a child (the caller has checked the guardian link and the
 * `screen_result_save` consent). Removes it from the 30-day deletion rule. Strict audit `screen.result_saved`
 * in the same transaction (fails closed).
 */
export async function saveScreenResult(input: {
  sessionId: string;
  childId: string;
  userId: string;
}): Promise<{ ok: true; created: boolean } | Failure> {
  const sql = await pg();
  return sql.begin(async (tx) => {
    const row = await lock(tx, input.sessionId);
    if (!row) return failure(404, NOT_FOUND);
    if (row.saved_child_id) {
      return row.saved_child_id === input.childId ? { ok: true as const, created: false } : failure(409, ALREADY_SAVED);
    }
    if (row.expired) return failure(410, EXPIRED);
    if (sessionStatus(row) !== "finished") return failure(409, NOT_SAVABLE);
    await tx`
      update public.screen_sessions set saved_child_id = ${input.childId}, saved_by = ${input.userId}
      where id = ${row.id} and saved_child_id is null`;
    await auditStrict(
      {
        actorUserId: input.userId,
        actorRole: "guardian",
        actor: "guardian",
        childId: input.childId,
        action: "screen.result_saved",
        entity: "screen_session",
        entityId: row.id,
        details: { age_band: row.age_band, result_band: row.result_band, mode: row.mode },
      },
      tx,
    );
    return { ok: true as const, created: true };
  });
}

export type ChildCheckin = { id: string; created_at: string; age_band: StoredAgeBand; result_band: CheckinBand };

/** FR-8: the child page's `Check-ins` list (newest first). Call after the guardian-link gate. */
export async function listChildCheckins(childId: string): Promise<ChildCheckin[]> {
  if (!isUuid(childId)) return [];
  const sql = await pg();
  const rows = await sql<{ id: string; created_at: Date; age_band: StoredAgeBand; result_band: CheckinBand }[]>`
    select id, created_at, age_band, result_band from public.screen_sessions
    where saved_child_id = ${childId} order by created_at desc`;
  return rows.map((r) => ({ ...r, created_at: r.created_at.toISOString() }));
}
