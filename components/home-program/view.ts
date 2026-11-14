// Ticket 026: shared view helpers for the home program UI (provider tab and the family page). Safe in the browser.
import { MSG } from "@/lib/home-program/schema";
import type { BadgeTone } from "@/components/ui/Badge";

const ERROR_KEYS = {
  [MSG.stale]: "stale",
  [MSG.archived]: "archived",
  [MSG.tooManyActivities]: "tooManyActivities",
  [MSG.noActivities]: "noActivities",
  [MSG.nothingToPublish]: "nothingToPublish",
  [MSG.goalNotInPlan]: "goalNotInPlan",
  [MSG.guideNotInCase]: "guideNotInCase",
  [MSG.futureDate]: "futureDate",
  [MSG.tooOld]: "tooOld",
  [MSG.notThisWeek]: "notThisWeek",
  [MSG.programNotFound]: "notFound",
  [MSG.activityNotFound]: "notFound",
  [MSG.logNotFound]: "notFound",
  "Invalid request": "invalid",
} as const;
export type HomeProgramErrorKey = (typeof ERROR_KEYS)[keyof typeof ERROR_KEYS] | "saveFailed";

export function homeProgramErrorKey(error: string | undefined | null): HomeProgramErrorKey {
  return (error && (ERROR_KEYS as Record<string, HomeProgramErrorKey>)[error]) || "saveFailed";
}

export type ApiResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: HomeProgramErrorKey; fields: string[] };

/** fetch + JSON with the error mapping. `status: 0` = network failure (offline). */
export async function sendJson<T>(fetchImpl: typeof fetch, url: string, method: string, body?: unknown): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    return { ok: false, status: 0, error: "saveFailed", fields: [] };
  }
  const json = (await res.json().catch(() => ({}))) as { error?: string; details?: Record<string, unknown> };
  if (res.ok) return { ok: true, status: res.status, data: json as T };
  let error = homeProgramErrorKey(json.error);
  // A field detail with a known message (e.g. a date outside the window) is more useful than "invalid".
  if (error === "invalid") {
    for (const message of Object.values(json.details ?? {})) {
      const specific = homeProgramErrorKey(String(message));
      if (specific !== "saveFailed") error = specific;
    }
  }
  return { ok: false, status: res.status, error, fields: Object.keys(json.details ?? {}) };
}

export const STATUS_TONES = {
  draft: "neutral",
  published: "success",
  archived: "neutral",
} as const satisfies Record<string, BadgeTone>;

export const DIFFICULTY_STYLES = {
  hard: "border-rose-300 bg-rose-50 text-rose-900",
  okay: "border-amber-300 bg-amber-50 text-amber-900",
  easy: "border-emerald-300 bg-emerald-50 text-emerald-900",
} as const;
