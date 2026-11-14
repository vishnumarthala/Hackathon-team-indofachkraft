// Ticket 025: shared view helpers for the IEP UI (provider Goals tab and the family plan page). Safe in the browser.
import type { Formatter } from "@/lib/i18n/format";
import type { TFunction } from "@/lib/i18n/keys";
import type { GoalTrend } from "@/lib/iep/progress";
import { MSG, type GoalDomain, type GoalStatus, type MeasureType, type PlanStatus } from "@/lib/iep/schema";
import type { BadgeTone } from "@/components/ui/Badge";

export const DOMAIN_KEYS = {
  communication: "communication",
  social: "social",
  behaviour: "behaviour",
  fine_motor: "fineMotor",
  gross_motor: "grossMotor",
  self_care: "selfCare",
  cognitive: "cognitive",
  sensory: "sensory",
  academic: "academic",
} as const satisfies Record<GoalDomain, string>;

export const MEASURE_KEYS = {
  percent: "percent",
  count: "count",
  rating_1_5: "rating15",
  yes_no: "yesNo",
} as const satisfies Record<MeasureType, string>;

export const PLAN_STATUS_TONES: Record<PlanStatus, BadgeTone> = {
  draft: "neutral",
  active: "success",
  completed: "info",
  archived: "neutral",
};

export const GOAL_STATUS_TONES: Record<GoalStatus, BadgeTone> = {
  active: "brand",
  achieved: "success",
  discontinued: "neutral",
};

/** API field names -> translated field-error keys (`iep.fieldErrors.*`). */
export const FIELD_ERROR_KEYS = {
  title: "title",
  start_date: "startDate",
  review_date: "reviewDate",
  domain: "domain",
  statement: "statement",
  specific: "smart",
  measurable: "smart",
  achievable: "smart",
  relevant: "smart",
  time_bound: "smart",
  measure_type: "measureType",
  baseline_value: "baseline",
  target_value: "target",
  target_date: "targetDate",
  observed_on: "observedOn",
  value: "value",
  note: "note",
} as const;
export type FieldName = keyof typeof FIELD_ERROR_KEYS;
export type FieldErrorKey = (typeof FIELD_ERROR_KEYS)[FieldName];

const ERROR_KEYS = {
  [MSG.stale]: "stale",
  [MSG.closed]: "closed",
  [MSG.tooManyGoals]: "tooManyGoals",
  [MSG.noGoals]: "noGoals",
  [MSG.nothingToPublish]: "nothingToPublish",
  [MSG.goalDiscontinued]: "goalDiscontinued",
  [MSG.measureLocked]: "measureLocked",
  [MSG.targetDateRange]: "targetDateRange",
  [MSG.planDatesExcludeGoals]: "planDatesExcludeGoals",
  [MSG.futureDate]: "futureDate",
  [MSG.valueRange]: "valueRange",
  [MSG.statusChange]: "statusChange",
  [MSG.planNotFound]: "notFound",
  [MSG.goalNotFound]: "notFound",
  "Invalid request": "invalid",
} as const;
export type IepErrorKey = (typeof ERROR_KEYS)[keyof typeof ERROR_KEYS] | "saveFailed";

export function iepErrorKey(error: string | undefined | null): IepErrorKey {
  return (error && (ERROR_KEYS as Record<string, IepErrorKey>)[error]) || "saveFailed";
}

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: IepErrorKey; fields: Partial<Record<FieldName, FieldErrorKey>> };

/** fetch + JSON with the IEP error mapping (400 details become translated field-error keys). */
export async function sendJson<T>(fetchImpl: typeof fetch, url: string, method: string, body?: unknown): Promise<ApiResult<T>> {
  try {
    const res = await fetchImpl(url, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string; details?: Record<string, unknown> };
    if (res.ok) return { ok: true, data: json as T };
    const fields: Partial<Record<FieldName, FieldErrorKey>> = {};
    for (const key of Object.keys(json.details ?? {})) {
      if (key in FIELD_ERROR_KEYS) fields[key as FieldName] = FIELD_ERROR_KEYS[key as FieldName];
    }
    let error = iepErrorKey(json.error);
    // A field detail with a known message (e.g. target date outside the plan) is more useful than "invalid".
    if (error === "invalid") {
      for (const message of Object.values(json.details ?? {})) {
        const specific = iepErrorKey(String(message));
        if (specific !== "saveFailed") error = specific;
      }
    }
    return { ok: false, status: res.status, error, fields };
  } catch {
    return { ok: false, status: 0, error: "saveFailed", fields: {} };
  }
}

/** A value in the measure's unit, translated (`40%`, `3`, `2 of 5`, `Yes`). */
export function formatValue(t: TFunction<"iep.values">, format: Pick<Formatter, "number">, measure: MeasureType, value: number): string {
  const n = format.number(Math.round(value * 100) / 100);
  switch (measure) {
    case "percent":
      return t("percent", { value: n });
    case "rating_1_5":
      return t("rating", { value: n });
    case "yes_no":
      return value >= 1 ? t("yes") : t("no");
    case "count":
      return n;
  }
}

/** FR-7 text next to a chart: latest value, change from baseline, % of the way, on track. */
export function trendLines(
  t: TFunction<"iep.trend">,
  value: (n: number) => string,
  format: Pick<Formatter, "number">,
  trend: GoalTrend,
): string[] {
  if (trend.latest === null) return [t("none")];
  const change = trend.change_from_baseline ?? 0;
  const lines = [
    t("latest", { value: value(trend.latest) }),
    t("change", { change: `${change > 0 ? "+" : change < 0 ? "−" : ""}${format.number(Math.abs(change))}` }),
    t("percent", { percent: trend.percent_to_target ?? 0 }),
  ];
  lines.push(trend.on_track === null ? t("needMore") : trend.on_track ? t("onTrack") : t("notOnTrack"));
  return lines;
}
