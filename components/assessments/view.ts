// Ticket 024: shared view helpers for the assessment UI. Safe in the browser.
import { MSG, type AssessmentStatus } from "@/lib/assessments/schemas";
import type { CheckinBand, RedFlagCode } from "@/lib/clinical/checkin";
import type { BadgeTone } from "@/components/ui/Badge";

export const STATUS_KEYS = {
  assigned: "assigned",
  in_progress: "inProgress",
  submitted: "submitted",
  reviewed: "reviewed",
  cancelled: "cancelled",
} as const satisfies Record<AssessmentStatus, string>;

export const BAND_KEYS = {
  no_strong_signs: "noStrongSigns",
  discuss_with_professional: "discussWithProfessional",
  see_professional_soon: "seeProfessionalSoon",
} as const satisfies Record<CheckinBand, string>;

export const RED_FLAG_KEYS = {
  skill_regression: "skillRegression",
  self_injury: "selfInjury",
  seizure: "seizure",
  breathing: "breathing",
  not_eating_drinking: "notEatingDrinking",
  safety_concern: "safetyConcern",
} as const satisfies Record<RedFlagCode, string>;

export const STATUS_TONES: Record<AssessmentStatus, BadgeTone> = {
  assigned: "neutral",
  in_progress: "warning",
  submitted: "info",
  reviewed: "success",
  cancelled: "neutral",
};

export const ANSWER_KEYS = ["never", "sometimes", "often", "always", "yes", "no"] as const;
export type AnswerKey = (typeof ANSWER_KEYS)[number];

export function isAnswerKey(value: unknown): value is AnswerKey {
  return typeof value === "string" && (ANSWER_KEYS as readonly string[]).includes(value);
}

export type ApiErrorKey =
  | "notLinked"
  | "alreadyOpen"
  | "chooseTemplate"
  | "notOpen"
  | "alreadyReviewed"
  | "notSubmitted"
  | "answerAll"
  | "alreadySubmitted"
  | "cancelled"
  | "stale"
  | "saveFailed";

const BY_MESSAGE: Record<string, ApiErrorKey> = {
  [MSG.notLinked]: "notLinked",
  [MSG.alreadyOpen]: "alreadyOpen",
  [MSG.chooseTemplate]: "chooseTemplate",
  [MSG.notOpen]: "notOpen",
  [MSG.alreadyReviewed]: "alreadyReviewed",
  [MSG.notSubmitted]: "notSubmitted",
  [MSG.answerAll]: "answerAll",
  [MSG.alreadySubmitted]: "alreadySubmitted",
  [MSG.cancelled]: "cancelled",
  [MSG.stale]: "stale",
};

/** Maps an API error body (English contract) to a translated message key. */
export function assessmentErrorKey(error: unknown): ApiErrorKey {
  return (typeof error === "string" && BY_MESSAGE[error]) || "saveFailed";
}
