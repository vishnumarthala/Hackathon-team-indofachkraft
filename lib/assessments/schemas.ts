// Ticket 024 FR-7..FR-9: request schemas, statuses and API messages of the assessment portal. Safe in the browser.
import { z } from "zod";
import { UUID_PATTERN } from "@/lib/cases/validation";

export const ASSESSMENT_STATUSES = ["assigned", "in_progress", "submitted", "reviewed", "cancelled"] as const;
export type AssessmentStatus = (typeof ASSESSMENT_STATUSES)[number];
export const OPEN_STATUSES: readonly AssessmentStatus[] = ["assigned", "in_progress"];

/** Global template seeded by the migration (`Parent developmental check-in`, ISAA_PARENT_CHECKIN). */
export const PARENT_CHECKIN_TEMPLATE_ID = "00000000-0000-4000-8024-000000000001";

// API error bodies (English contract; clients map statuses to translated text).
export const MSG = {
  notFound: "Assessment not found",
  notLinked: "This parent is not linked to the child",
  chooseTemplate: "Choose a questionnaire",
  alreadyOpen: "This questionnaire is already open for this parent",
  answerAll: "Please answer all questions",
  alreadySubmitted: "Already submitted",
  cancelled: "This questionnaire was cancelled",
  stale: "Your answers were changed in another window. Reload to continue.",
  notSubmitted: "Not submitted yet",
  alreadyReviewed: "Already reviewed",
  notOpen: "Only open questionnaires can be cancelled",
  invalidAnswer: "Invalid answer",
} as const;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Today in the clinic time zone (Asia/Kolkata) as YYYY-MM-DD. */
export function todayInIndia(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function makeAssignSchema(now: Date = new Date()) {
  const today = todayInIndia(now);
  const latest = addDays(today, 366);
  return z
    .object({
      template_id: z.string({ error: MSG.chooseTemplate }).regex(UUID_PATTERN, { error: MSG.chooseTemplate }),
      assigned_to: z.string({ error: "Choose a parent" }).regex(UUID_PATTERN, { error: "Choose a parent" }),
      due_on: z
        .string()
        .regex(DATE, { error: "Enter a valid date" })
        .refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)), { error: "Enter a valid date" })
        .refine((d) => d >= today, { error: "The due date cannot be in the past" })
        .refine((d) => d <= latest, { error: "The due date must be within a year" })
        .nullish()
        .transform((v) => v ?? null),
    })
    .strict();
}
export type AssignInput = z.output<ReturnType<typeof makeAssignSchema>>;

export const ResponsesSchema = z
  .object({
    answers: z
      .array(
        z.object({
          item_id: z.string().min(1).max(40),
          value: z.union([z.string().max(40), z.number(), z.boolean()]),
        }),
      )
      .max(100),
    version: z.number({ error: "version is required" }).int().min(1),
  })
  .strict();
export type ResponsesInput = z.output<typeof ResponsesSchema>;

export const ReviewSchema = z
  .object({
    note: z.string().trim().max(2000, { error: "The note must be at most 2000 characters" }).optional(),
    share_with_parent: z.boolean().default(false),
  })
  .strict();
export type ReviewInput = z.output<typeof ReviewSchema>;
