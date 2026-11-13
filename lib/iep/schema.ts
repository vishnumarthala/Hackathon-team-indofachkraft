// Ticket 025 FR-2: IEP request schemas, enums, value ranges and API messages. Safe in the browser.
// Server routes parse with these schemas; lib/iep re-checks the cross-field rules (goal dates vs plan dates)
// against the locked plan row. The SQL migration repeats the value ranges as check constraints.
import { z } from "zod";

export const PLAN_STATUSES = ["draft", "active", "completed", "archived"] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export const GOAL_DOMAINS = [
  "communication",
  "social",
  "behaviour",
  "fine_motor",
  "gross_motor",
  "self_care",
  "cognitive",
  "sensory",
  "academic",
] as const;
export type GoalDomain = (typeof GOAL_DOMAINS)[number];

/** English domain names used in the published markdown (the published document is not translated). */
export const DOMAIN_LABELS_EN: Record<GoalDomain, string> = {
  communication: "Communication",
  social: "Social",
  behaviour: "Behaviour",
  fine_motor: "Fine motor",
  gross_motor: "Gross motor",
  self_care: "Self-care",
  cognitive: "Cognitive",
  sensory: "Sensory",
  academic: "Academic",
};

export const MEASURE_TYPES = ["percent", "count", "rating_1_5", "yes_no"] as const;
export type MeasureType = (typeof MEASURE_TYPES)[number];

export const GOAL_STATUSES = ["active", "achieved", "discontinued"] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

export const PROGRESS_SOURCES = ["manual", "ai_suggested_confirmed"] as const;
export type ProgressSource = (typeof PROGRESS_SOURCES)[number];

export const SMART_FIELDS = ["specific", "measurable", "achievable", "relevant", "time_bound"] as const;
export type SmartField = (typeof SMART_FIELDS)[number];

export const MAX_GOALS_PER_PLAN = 20;

// API error bodies (English contract; clients map them to translated text with `iepErrorKey`).
export const MSG = {
  planNotFound: "Plan not found",
  goalNotFound: "Goal not found",
  stale: "This plan was changed by someone else. Reload to see the latest version.",
  closed: "This plan is closed and can no longer be changed",
  tooManyGoals: `A plan can have at most ${MAX_GOALS_PER_PLAN} goals`,
  noGoals: "Add at least one goal before publishing",
  nothingToPublish: "There are no changes to publish",
  goalDiscontinued: "This goal was discontinued",
  measureLocked: "The measure cannot change after progress has been recorded",
  targetDateRange: "The target date must be between the plan's start and review dates",
  planDatesExcludeGoals: "Some goals have target dates outside these plan dates",
  futureDate: "The date cannot be in the future",
  valueRange: "Enter a value that fits the measure",
  recordingNotInCase: "The recording does not belong to this case",
  statusChange: "This status change is not allowed",
} as const;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Today in the clinic time zone (Asia/Kolkata) as YYYY-MM-DD. */
export function todayInIndia(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** `date` + `months` calendar months, end-of-month clamped like Postgres (2027-01-31 + 1 month = 2027-02-28). */
export function addMonths(isoDate: string, months: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(d, lastDay));
  return first.toISOString().slice(0, 10);
}

export type ValueRange = { min: number; max: number | null; integer: boolean };

export const VALUE_RANGES: Record<MeasureType, ValueRange> = {
  percent: { min: 0, max: 100, integer: false },
  count: { min: 0, max: null, integer: false },
  rating_1_5: { min: 1, max: 5, integer: false },
  yes_no: { min: 0, max: 1, integer: true },
};

/** FR-2: `percent` 0-100, `rating_1_5` 1-5, `yes_no` 0/1, `count` >= 0. */
export function valueInRange(measure: MeasureType, value: number): boolean {
  if (!Number.isFinite(value)) return false;
  const r = VALUE_RANGES[measure];
  if (r.integer && !Number.isInteger(value)) return false;
  return value >= r.min && (r.max === null || value <= r.max);
}

/** Plan date rules: review on or after start, at most 12 months after it. Returns an error message or null. */
export function planDatesError(startDate: string, reviewDate: string): string | null {
  if (reviewDate < startDate) return "The review date must be on or after the start date";
  if (reviewDate > addMonths(startDate, 12)) return "The review date must be within 12 months of the start date";
  return null;
}

/** Goal target date must lie within the plan's dates (inclusive). */
export function targetDateInPlan(targetDate: string, plan: { start_date: string; review_date: string }): boolean {
  return targetDate >= plan.start_date && targetDate <= plan.review_date;
}

const dateField = (label: string) =>
  z.string({ error: `${label} is required` }).refine(isValidIsoDate, { error: `${label} must be a valid date (YYYY-MM-DD)` });

const text = (label: string, min: number, max: number) =>
  z
    .string({ error: `${label} is required` })
    .trim()
    .min(min, { error: min <= 1 ? `${label} is required` : `${label} must be at least ${min} characters` })
    .max(max, { error: `${label} must be at most ${max} characters` });

const version = z.number({ error: "version is required" }).int().min(1);
const numberField = (label: string) => z.number({ error: `${label} must be a number` });

// ---------------------------------------------------------------------------------------------------------
// Plans

export const PlanCreateSchema = z
  .object({
    title: text("Title", 1, 120),
    start_date: dateField("Start date"),
    review_date: dateField("Review date"),
  })
  .strict()
  .superRefine((v, ctx) => {
    const err = planDatesError(v.start_date, v.review_date);
    if (err) ctx.addIssue({ code: "custom", path: ["review_date"], message: err });
  });
export type PlanCreateInput = z.output<typeof PlanCreateSchema>;

/** Status changes through PATCH; `active` only comes from publishing. */
export const PATCHABLE_PLAN_STATUSES = ["completed", "archived"] as const;

export const PlanPatchSchema = z
  .object({
    title: text("Title", 1, 120).optional(),
    start_date: dateField("Start date").optional(),
    review_date: dateField("Review date").optional(),
    status: z.enum(PATCHABLE_PLAN_STATUSES, { error: "Choose completed or archived" }).optional(),
    version,
  })
  .strict();
export type PlanPatchInput = z.output<typeof PlanPatchSchema>;

export const PublishSchema = z.object({ version }).strict();

// ---------------------------------------------------------------------------------------------------------
// Goals

const goalShape = {
  domain: z.enum(GOAL_DOMAINS, { error: "Choose a domain" }),
  statement: text("Goal", 10, 500),
  specific: text("Specific", 3, 300),
  measurable: text("Measurable", 3, 300),
  achievable: text("Achievable", 3, 300),
  relevant: text("Relevant", 3, 300),
  time_bound: text("Time-bound", 3, 300),
  measure_type: z.enum(MEASURE_TYPES, { error: "Choose how we measure" }),
  baseline_value: numberField("Baseline"),
  target_value: numberField("Target"),
  target_date: dateField("Target date"),
};

export type GoalFields = {
  domain: GoalDomain;
  statement: string;
  specific: string;
  measurable: string;
  achievable: string;
  relevant: string;
  time_bound: string;
  measure_type: MeasureType;
  baseline_value: number;
  target_value: number;
  target_date: string;
};

/** Cross-field goal rules that do not need the plan. Returns `{ field: message }` (empty when valid). */
export function goalValueErrors(g: Pick<GoalFields, "measure_type" | "baseline_value" | "target_value">): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!valueInRange(g.measure_type, g.baseline_value)) errors.baseline_value = MSG.valueRange;
  if (!valueInRange(g.measure_type, g.target_value)) errors.target_value = MSG.valueRange;
  if (!errors.baseline_value && !errors.target_value && g.baseline_value === g.target_value) {
    errors.target_value = "The target must differ from the baseline";
  }
  return errors;
}

export const GoalCreateSchema = z
  .object({ ...goalShape, version })
  .strict()
  .superRefine((v, ctx) => {
    for (const [path, message] of Object.entries(goalValueErrors(v))) ctx.addIssue({ code: "custom", path: [path], message });
  });
export type GoalCreateInput = z.output<typeof GoalCreateSchema>;

export const GoalPatchSchema = z
  .object({
    domain: goalShape.domain.optional(),
    statement: goalShape.statement.optional(),
    specific: goalShape.specific.optional(),
    measurable: goalShape.measurable.optional(),
    achievable: goalShape.achievable.optional(),
    relevant: goalShape.relevant.optional(),
    time_bound: goalShape.time_bound.optional(),
    measure_type: goalShape.measure_type.optional(),
    baseline_value: goalShape.baseline_value.optional(),
    target_value: goalShape.target_value.optional(),
    target_date: goalShape.target_date.optional(),
    status: z.enum(GOAL_STATUSES, { error: "Choose a goal status" }).optional(),
    sort: z.number().int().min(0).max(1000).optional(),
    version,
  })
  .strict();
export type GoalPatchInput = z.output<typeof GoalPatchSchema>;

// ---------------------------------------------------------------------------------------------------------
// Progress

/** FR-3: `{ observed_on, value, note? }`; the date cannot be in the future (India). */
export function makeProgressSchema(now: Date = new Date()) {
  const today = todayInIndia(now);
  return z
    .object({
      observed_on: dateField("Date").refine((d) => d <= today, { error: MSG.futureDate }),
      value: numberField("Value"),
      note: z
        .string()
        .trim()
        .max(500, { error: "The note must be at most 500 characters" })
        .optional()
        .transform((v) => (v ? v : null)),
    })
    .strict();
}
export type ProgressInput = z.output<ReturnType<typeof makeProgressSchema>>;
