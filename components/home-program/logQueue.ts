// Ticket 026 NFR-1: offline-safe `Done today`. The client resends the SAME body (activity + done_on) until the server
// answers; the server upserts on (activity, day, guardian), so a retry never makes a second row. When the phone is
// offline the request is kept in localStorage and sent when the browser is online again. Safe in the browser; pure
// apart from the injected fetch/storage.
import { sendJson, type ApiResult } from "./view";

export type LogBody = { done_on: string; difficulty: "hard" | "okay" | "easy"; duration_min?: number | null; note?: string | null };
export type PendingLog = { activityId: string; body: LogBody };
export type KeyValueStorage = Pick<Storage, "getItem" | "setItem">;

export const QUEUE_KEY = "dnm.homeProgram.pendingLogs";

export const logUrl = (activityId: string) => `/api/family/home-activities/${activityId}/logs`;

export function readQueue(storage: KeyValueStorage | null): PendingLog[] {
  if (!storage) return [];
  try {
    const parsed = JSON.parse(storage.getItem(QUEUE_KEY) ?? "[]");
    return Array.isArray(parsed) ? (parsed as PendingLog[]) : [];
  } catch {
    return [];
  }
}

function writeQueue(storage: KeyValueStorage | null, items: PendingLog[]) {
  try {
    storage?.setItem(QUEUE_KEY, JSON.stringify(items));
  } catch {
    // Storage full or disabled: nothing more we can do offline.
  }
}

/** Adds (or replaces) the pending log for the same activity and day. */
export function enqueueLog(storage: KeyValueStorage | null, item: PendingLog) {
  const rest = readQueue(storage).filter((p) => !(p.activityId === item.activityId && p.body.done_on === item.body.done_on));
  writeQueue(storage, [...rest, item]);
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type SubmitResult<T> = ApiResult<T> | { ok: false; status: 0; queued: true };

/**
 * POSTs a log, retrying network failures and 5xx answers with the same body. If the phone stays offline the log is
 * queued (`queued: true`). 4xx answers are returned as they are (nothing to retry).
 */
export async function submitLog<T>(
  fetchImpl: typeof fetch,
  item: PendingLog,
  opts: { retries?: number; delayMs?: number; storage?: KeyValueStorage | null } = {},
): Promise<SubmitResult<T>> {
  const retries = opts.retries ?? 2;
  let result: ApiResult<T> = { ok: false, status: 0, error: "saveFailed", fields: [] };
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await wait((opts.delayMs ?? 800) * attempt);
    result = await sendJson<T>(fetchImpl, logUrl(item.activityId), "POST", item.body);
    if (result.ok || (result.status >= 400 && result.status < 500)) return result;
  }
  if (result.status === 0) {
    enqueueLog(opts.storage ?? null, item);
    return { ok: false, status: 0, queued: true };
  }
  return result;
}

/** Sends queued logs; keeps only those that still could not reach the server. Returns how many were delivered. */
export async function flushQueue(fetchImpl: typeof fetch, storage: KeyValueStorage | null): Promise<number> {
  const pending = readQueue(storage);
  if (pending.length === 0) return 0;
  const keep: PendingLog[] = [];
  let sent = 0;
  for (const item of pending) {
    const result = await sendJson(fetchImpl, logUrl(item.activityId), "POST", item.body);
    if (result.ok) sent += 1;
    else if (result.status === 0 || result.status >= 500) keep.push(item);
    // 4xx (e.g. older than 14 days, activity stopped): dropping it is the only option.
  }
  writeQueue(storage, keep);
  return sent;
}
