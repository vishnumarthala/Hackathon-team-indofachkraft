// Shared fact update helpers for PATCH /api/facts/:id and POST /api/sessions/:id/bulk (007).
// The pure rules (no I/O) are unit tested in tests/facts.test.ts; the DB helpers run each update
// in one transaction that locks the recording row, so a running extraction is never overwritten.
import type postgres from "postgres";
import { z } from "zod";
import { env } from "@/lib/env";
import { isUuid } from "@/lib/cases/validation";
import { scoreIsaa, type IsaaScore, type ScoringFact } from "@/lib/scoring";
import type { FactRow } from "@/lib/types";

export type FactStatus = "suggested" | "confirmed" | "edited";

export const FactActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("confirm") }),
  z.object({
    action: z.literal("edit"),
    value: z.number({ error: "Value must be a rating from 1 to 5" }).int().min(1).max(5),
  }),
]);
export type FactAction = z.infer<typeof FactActionSchema>;

export const BulkActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("confirm_suggested") }),
  z.object({ action: z.literal("rate_unrated"), value: z.literal(1) }),
]);
export type BulkAction = z.infer<typeof BulkActionSchema>;

export type FactState = { value: number | null; status: FactStatus };

export type FactChange = {
  value: number;
  status: "confirmed" | "edited";
  auditAction: "fact.confirmed" | "fact.edited";
};

export type RuleError = { status: 422; error: string };

export const RATE_BEFORE_CONFIRM = "Rate this item before confirming";
export const ISAA_ONLY = "Only ISAA items can be rated here";
export const FACT_NOT_FOUND = "Fact not found";
export const SESSION_NOT_FOUND = "Session not found";
export const EXTRACTION_RUNNING = "Extraction already running";

export function ratingOf(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 5 ? value : null;
}

// FR-6: confirm keeps the value; edit sets it. Picking the value the AI already suggested counts as a confirm.
export function applyFactAction(fact: FactState, action: FactAction): FactChange | RuleError {
  if (action.action === "confirm") {
    if (fact.value === null) return { status: 422, error: RATE_BEFORE_CONFIRM };
    return { value: fact.value, status: "confirmed", auditAction: "fact.confirmed" };
  }
  if (action.value === fact.value && fact.status === "suggested") {
    return { value: action.value, status: "confirmed", auditAction: "fact.confirmed" };
  }
  return { value: action.value, status: "edited", auditAction: "fact.edited" };
}

export function isRuleError(result: FactChange | RuleError): result is RuleError {
  return "error" in result;
}

// FR-8: which facts a bulk action changes, and how.
export function bulkTargets<T extends FactState & { id: string }>(
  facts: T[],
  action: BulkAction,
): { id: string; value: number; status: "confirmed" | "edited" }[] {
  if (action.action === "confirm_suggested") {
    return facts
      .filter((f) => f.status === "suggested" && f.value !== null)
      .map((f) => ({ id: f.id, value: f.value as number, status: "confirmed" as const }));
  }
  return facts
    .filter((f) => f.value === null)
    .map((f) => ({ id: f.id, value: action.value, status: "edited" as const }));
}

export function bulkAuditAction(action: BulkAction): "facts.bulk_confirmed" | "facts.bulk_rated" {
  return action.action === "confirm_suggested" ? "facts.bulk_confirmed" : "facts.bulk_rated";
}

export function toScoringFacts(rows: { item_id: string; value: unknown; status: string }[]): ScoringFact[] {
  return rows.map((r) => ({ item_id: r.item_id, value: ratingOf(r.value), status: r.status }));
}

// ---------------------------------------------------------------------------------------------
// Database (server only)

type Sql = postgres.Sql;
type Tx = postgres.TransactionSql;

const globalForSql = globalThis as unknown as { __carethreadSql?: Sql };

async function db(): Promise<Sql> {
  if (typeof window !== "undefined") throw new Error("lib/facts.ts is server-only");
  if (!globalForSql.__carethreadSql) {
    const { default: postgresClient } = await import("postgres");
    // prepare: false keeps it working behind the Supabase pooler as well as against local Postgres.
    globalForSql.__carethreadSql = postgresClient(env.DATABASE_URL, { max: 5, prepare: false, onnotice: () => {} });
  }
  return globalForSql.__carethreadSql;
}

export type UpdateResult<T> = { ok: true; data: T } | { ok: false; status: 404 | 409 | 422; error: string };

type RecordingLock = { id: string; case_id: string; kind: string; status: string; therapist_name: string };

async function lockRecording(tx: Tx, recordingId: string): Promise<RecordingLock | null> {
  const rows = await tx<RecordingLock[]>`
    select r.id, r.case_id, r.kind, r.status, c.therapist_name
    from recordings r join cases c on c.id = r.case_id
    where r.id = ${recordingId}
    for update of r`;
  return rows[0] ?? null;
}

async function recordingScore(tx: Tx, recordingId: string): Promise<IsaaScore> {
  const rows = await tx<{ item_id: string; value: unknown; status: string }[]>`
    select item_id, value, status from facts where recording_id = ${recordingId} and instrument = 'ISAA'`;
  return scoreIsaa(toScoringFacts(rows));
}

function factRow(row: Record<string, unknown>): FactRow {
  const toIso = (v: unknown) => (v instanceof Date ? v.toISOString() : (v as string | null));
  return {
    ...(row as unknown as FactRow),
    confidence: row.confidence === null ? null : Number(row.confidence),
    confirmed_at: toIso(row.confirmed_at),
    created_at: toIso(row.created_at) as string,
  };
}

export async function updateFact(
  factId: string,
  action: FactAction,
): Promise<UpdateResult<{ fact: FactRow; score: IsaaScore }>> {
  if (!isUuid(factId)) return { ok: false, status: 404, error: FACT_NOT_FOUND };
  const sql = await db();

  return sql.begin(async (tx) => {
    const found = await tx<{ recording_id: string }[]>`select recording_id from facts where id = ${factId}`;
    if (!found[0]) return { ok: false, status: 404, error: FACT_NOT_FOUND } as const;

    const recording = await lockRecording(tx, found[0].recording_id);
    if (!recording) return { ok: false, status: 404, error: FACT_NOT_FOUND } as const;
    if (recording.status === "extracting") return { ok: false, status: 409, error: EXTRACTION_RUNNING } as const;

    // Re-read under the lock so the rule sees the latest value and status.
    const facts = await tx<Record<string, unknown>[]>`select * from facts where id = ${factId} for update`;
    const fact = facts[0];
    if (!fact) return { ok: false, status: 404, error: FACT_NOT_FOUND } as const;
    if (fact.instrument !== "ISAA") return { ok: false, status: 422, error: ISAA_ONLY } as const;

    const before: FactState = { value: ratingOf(fact.value), status: fact.status as FactStatus };
    const change = applyFactAction(before, action);
    if (isRuleError(change)) return { ok: false, status: change.status, error: change.error } as const;

    const updated = await tx<Record<string, unknown>[]>`
      update facts
      set value = to_jsonb(${change.value}::int), status = ${change.status},
          confirmed_by = ${recording.therapist_name}, confirmed_at = now()
      where id = ${factId}
      returning *`;

    const details = {
      item_id: Number(fact.item_id),
      from_value: before.value,
      to_value: change.value,
      from_status: before.status,
      to_status: change.status,
    };
    await tx`
      insert into audit_events (case_id, actor, action, entity, entity_id, details)
      values (${recording.case_id}, 'therapist', ${change.auditAction}, 'fact', ${factId}, ${tx.json(details)})`;

    const score = await recordingScore(tx, recording.id);
    return { ok: true, data: { fact: factRow(updated[0]), score } } as const;
  });
}

export async function bulkUpdate(
  recordingId: string,
  action: BulkAction,
): Promise<UpdateResult<{ updated: number; score: IsaaScore }>> {
  if (!isUuid(recordingId)) return { ok: false, status: 404, error: SESSION_NOT_FOUND };
  const sql = await db();

  return sql.begin(async (tx) => {
    const recording = await lockRecording(tx, recordingId);
    if (!recording || recording.kind !== "session") return { ok: false, status: 404, error: SESSION_NOT_FOUND } as const;
    if (recording.status === "extracting") return { ok: false, status: 409, error: EXTRACTION_RUNNING } as const;

    const rows = await tx<{ id: string; value: unknown; status: string }[]>`
      select id, value, status from facts
      where recording_id = ${recordingId} and instrument = 'ISAA'
      for update`;
    const facts = rows.map((r) => ({ id: r.id, value: ratingOf(r.value), status: r.status as FactStatus }));
    const targets = bulkTargets(facts, action);

    if (targets.length > 0) {
      const ids = targets.map((t) => t.id);
      if (action.action === "confirm_suggested") {
        await tx`
          update facts set status = 'confirmed', confirmed_by = ${recording.therapist_name}, confirmed_at = now()
          where id in ${tx(ids)}`;
      } else {
        await tx`
          update facts set value = to_jsonb(${action.value}::int), status = 'edited',
                 confirmed_by = ${recording.therapist_name}, confirmed_at = now()
          where id in ${tx(ids)}`;
      }
    }

    await tx`
      insert into audit_events (case_id, actor, action, entity, entity_id, details)
      values (${recording.case_id}, 'therapist', ${bulkAuditAction(action)}, 'recording', ${recordingId},
              ${tx.json({ count: targets.length })})`;

    const score = await recordingScore(tx, recordingId);
    return { ok: true, data: { updated: targets.length, score } } as const;
  });
}
