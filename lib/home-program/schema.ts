// Ticket 026 FR-1/FR-2/FR-5: home program request schemas, limits and API messages. Safe in the browser.
// Server routes parse with these schemas; lib/home-program re-checks the rules that need the database (goal of the
// case's active plan, guide document of the case, 15 active activities) under the program row lock.
import { z } from "zod";
import { addDays, isValidIsoDate } from "@/lib/home-program/adherence";

export const PROGRAM_STATUSES = ["draft", "published", "archived"] as const;
export type ProgramStatus = (typeof PROGRAM_STATUSES)[number];

export const DIFFICULTIES = ["hard", "okay", "easy"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

export const MAX_ACTIVE_ACTIVITIES = 15;
/** Guardians may log today and up to this many days back (FR-5). */
export const LOG_WINDOW_DAYS = 14;

// API error bodies (English contract; clients map them to translated text).
export const MSG = {
  programNotFound: "Home program not found",
  activityNotFound: "Activity not found",
  logNotFound: "Log not found",
  stale: "This home program was changed by someone else. Reload to see the latest version.",
  archived: "This home program is archived and can no longer be changed",
  tooManyActivities: `A home program can have at most ${MAX_ACTIVE_ACTIVITIES} active activities`,
  noActivities: "Add at least one activity before publishing",
  nothingToPublish: "There are no changes to publish",
  goalNotInPlan: "Choose a goal from this child's plan",
  guideNotInCase: "Choose a guide from this case's documents that the parent can see",
  futureDate: "The date cannot be in the future",
  tooOld: `You can only log the last ${LOG_WINDOW_DAYS} days`,
  notThisWeek: "Only this week's entries can be removed",
  noCaseChild: "This case has no child record yet",
} as const;

const version = z.number({ error: "version is required" }).int().min(1);

const text = (label: string, min: number, max: number) =>
  z
    .string({ error: `${label} is required` })
    .trim()
    .min(min, { error: `${label} is required` })
    .max(max, { error: `${label} must be at most ${max} characters` });

const optionalText = (label: string, max: number) =>
  z
    .string()
    .trim()
    .max(max, { error: `${label} must be at most ${max} characters` })
    .nullable()
    .optional()
    .transform((v) => (v ? v : null));

const intRange = (label: string, min: number, max: number) =>
  z
    .number({ error: `${label} must be a number` })
    .int({ error: `${label} must be a whole number` })
    .min(min, { error: `${label} must be between ${min} and ${max}` })
    .max(max, { error: `${label} must be between ${min} and ${max}` });

/** Optional id: `""` / null clear the link, a missing key leaves it unchanged (undefined). */
const optionalUuid = (label: string) =>
  z
    .union([z.uuid({ error: `Choose a valid ${label}` }), z.literal(""), z.null()])
    .optional()
    .transform((v) => (v === undefined ? undefined : v || null));

// ---------------------------------------------------------------------------------------------------------
// Programs

export const ProgramCreateSchema = z.object({ title: text("Title", 1, 120) }).strict();
export type ProgramCreateInput = z.output<typeof ProgramCreateSchema>;

/** `published` only comes from publishing; PATCH can rename or archive. */
export const ProgramPatchSchema = z
  .object({
    title: text("Title", 1, 120).optional(),
    status: z.literal("archived", { error: "Only archiving is allowed here" }).optional(),
    version,
  })
  .strict();
export type ProgramPatchInput = z.output<typeof ProgramPatchSchema>;

export const PublishSchema = z.object({ version }).strict();

// ---------------------------------------------------------------------------------------------------------
// Activities

const activityShape = {
  title: text("Activity", 1, 120),
  instructions_md: text("How to do it", 1, 4000),
  frequency_per_week: intRange("Times per week", 1, 14),
  duration_min: intRange("Minutes", 1, 120),
  materials: optionalText("Materials", 500),
  goal_id: optionalUuid("goal"),
  document_id: optionalUuid("guide"),
};

export const ActivityCreateSchema = z.object({ ...activityShape, version: version.optional() }).strict();
export type ActivityCreateInput = z.output<typeof ActivityCreateSchema>;

export const ActivityPatchSchema = z
  .object({
    title: activityShape.title.optional(),
    instructions_md: activityShape.instructions_md.optional(),
    frequency_per_week: activityShape.frequency_per_week.optional(),
    duration_min: activityShape.duration_min.optional(),
    materials: z
      .string()
      .trim()
      .max(500, { error: "Materials must be at most 500 characters" })
      .nullable()
      .optional()
      .transform((v) => (v === undefined ? undefined : v || null)),
    goal_id: activityShape.goal_id,
    document_id: activityShape.document_id,
    sort: z.number().int().min(0).max(1000).optional(),
    active: z.boolean().optional(),
    version: version.optional(),
  })
  .strict();
export type ActivityPatchInput = z.output<typeof ActivityPatchSchema>;

// ---------------------------------------------------------------------------------------------------------
// Guardian logs

/** `done_on` must lie in [today - 14 days, today] in the guardian's time zone (`today` = YYYY-MM-DD there). */
export function logDateError(doneOn: string, today: string): string | null {
  if (!isValidIsoDate(doneOn)) return "Date must be a valid date (YYYY-MM-DD)";
  if (doneOn > today) return MSG.futureDate;
  if (doneOn < addDays(today, -LOG_WINDOW_DAYS)) return MSG.tooOld;
  return null;
}

/** FR-5: `{ done_on, difficulty, duration_min?, note? }`; `today` in the guardian's time zone. */
export function makeLogSchema(today: string) {
  return z
    .object({
      done_on: z.string({ error: "Date is required" }).superRefine((v, ctx) => {
        const err = logDateError(v, today);
        if (err) ctx.addIssue({ code: "custom", message: err });
      }),
      difficulty: z.enum(DIFFICULTIES, { error: "Choose how it went" }),
      duration_min: z
        .number({ error: "Minutes must be a number" })
        .int({ error: "Minutes must be a whole number" })
        .min(1, { error: "Minutes must be between 1 and 240" })
        .max(240, { error: "Minutes must be between 1 and 240" })
        .nullable()
        .optional()
        .transform((v) => v ?? null),
      note: optionalText("Note", 500),
    })
    .strict();
}
export type LogInput = z.output<ReturnType<typeof makeLogSchema>>;
