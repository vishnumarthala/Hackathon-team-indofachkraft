// FR-1 / FR-4 producer API. Two ways to emit a notification event:
//   1. `enqueue(tx, {...})` inside the caller's `sql.begin(...)` transaction (lib/pg.ts): the event commits or
//      rolls back with the domain write (preferred; exactly-once through the dedup key).
//      SQL functions call `perform public.outbox_enqueue(...)` instead.
//   2. `enqueueEvent({...})` for service-role code that writes through supabase-js (no shared transaction): call it
//      right after the write succeeded; the dedup key makes a retry of the whole action safe.
// Instant topics then call `drainSoon([id])` so delivery happens right after the response (Next.js `after()`);
// the every-minute cron picks up everything else (scheduled reminders, retries, anything `after()` missed).
import { after } from "next/server";
import { supabaseAdmin } from "@/lib/db";
import type { Queryable } from "@/lib/pg";
import { getTopic, type Topic, type TopicPayload } from "./topics";

export type EnqueueInput<T extends Topic = Topic> = {
  topic: T;
  aggregateType: string;
  aggregateId: string;
  payload: TopicPayload<T>;
  /** Unique per logical event, e.g. `message:<id>` or `appt:<id>:r24`. Cancel by prefix with `cancelEvents`. */
  dedupKey: string;
  /** Scheduled delivery (default now). */
  deliverAfter?: Date;
};

/** Validates topic + payload (strict schema: ids and small non-clinical values only). Throws on programmer error. */
export function validateEvent<T extends Topic>(input: EnqueueInput<T>): Record<string, unknown> {
  const def = getTopic(input.topic);
  if (!def) throw new Error(`Unknown notification topic: ${input.topic}`);
  const parsed = def.payload.safeParse(input.payload);
  if (!parsed.success) throw new Error(`Invalid payload for ${input.topic}: ${parsed.error.issues.map((i) => i.path.join(".") || "payload").join(", ")}`);
  if (!input.dedupKey || input.dedupKey.length > 300) throw new Error("dedupKey must be 1-300 characters");
  return parsed.data;
}

/** Enqueue inside the caller's transaction. Returns the event id (the existing one when the dedup key is taken). */
export async function enqueue<T extends Topic>(sql: Queryable, input: EnqueueInput<T>): Promise<string> {
  const payload = validateEvent(input);
  const [row] = await sql<{ id: string }[]>`
    select public.outbox_enqueue(${input.topic}, ${input.aggregateType}, ${input.aggregateId}::uuid,
      ${sql.json(payload as Parameters<typeof sql.json>[0])}, ${input.dedupKey},
      ${input.deliverAfter ?? null}::timestamptz) as id`;
  return String(row.id);
}

/** Non-transactional enqueue for service-role JS code; by default also schedules an immediate drain. */
export async function enqueueEvent<T extends Topic>(input: EnqueueInput<T>, opts: { drain?: boolean } = {}): Promise<string> {
  const payload = validateEvent(input);
  const { data, error } = await supabaseAdmin().rpc("outbox_enqueue", {
    p_topic: input.topic,
    p_aggregate_type: input.aggregateType,
    p_aggregate_id: input.aggregateId,
    p_payload: payload,
    p_dedup_key: input.dedupKey,
    p_deliver_after: (input.deliverAfter ?? new Date()).toISOString(),
  });
  if (error) throw new Error(`Could not enqueue notification: ${error.message}`);
  const id = String(data);
  if (opts.drain !== false && (!input.deliverAfter || input.deliverAfter.getTime() <= Date.now())) drainSoon([id]);
  return id;
}

/** FR-1 `outbox_cancel`: pending events whose dedup key starts with `prefix`, and their unsent notifications. */
export async function cancelEvents(prefix: string, sql?: Queryable): Promise<number> {
  if (!prefix) throw new Error("prefix required");
  if (sql) {
    const [row] = await sql<{ n: number }[]>`select public.outbox_cancel(${prefix}) as n`;
    return row.n;
  }
  const { data, error } = await supabaseAdmin().rpc("outbox_cancel", { p_dedup_key_prefix: prefix });
  if (error) throw new Error(`Could not cancel notifications: ${error.message}`);
  return Number(data);
}

/**
 * Delivers the given events (or, without ids, one small batch of whatever is due) right after the current
 * response, using Next.js `after()`. Outside a request (scripts, tests) it does nothing: the cron or
 * `npm run outbox:run` delivers instead. Never throws, never delays the response.
 */
export function drainSoon(eventIds?: string[]): void {
  try {
    after(async () => {
      try {
        const { runOutbox } = await import("./worker");
        await runOutbox(eventIds?.length ? { eventIds } : { sendBatch: 20 });
      } catch (err) {
        console.error(`[notify] drain failed: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`);
      }
    });
  } catch {
    // Not inside a request scope.
  }
}
