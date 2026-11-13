// 036 rating rules (pure, shared by the API, the pages and the tests). D-1: only the booking guardian of a completed
// appointment rates it, within 30 days of completion, once (edits within 7 days of rating). D-2: the average is shown
// from 3 published ratings.

export const RATE_WINDOW_DAYS = 30;
export const EDIT_WINDOW_DAYS = 7;
export const PROMPT_DELAY_HOURS = 2;
export const DISPLAY_THRESHOLD = 3;
export const COMMENT_MAX = 500;
export const PUBLIC_COMMENT_LIMIT = 10;

export const RATING_STATUSES = ["published", "hidden", "pending_review"] as const;
export type RatingStatus = (typeof RATING_STATUSES)[number];
export type ReviewReason = "abuse_screen" | "provider_report";

export const NOT_ELIGIBLE = "You can rate only your completed appointments";
export const ALREADY_RATED = "You already rated this visit";
export const EDIT_CLOSED = "Ratings can be changed only within 7 days";
export const RATING_LOCKED = "This rating can no longer be changed";

const DAY_MS = 86_400_000;

export type EligibilityInput = {
  status: string;
  guardianUserId: string | null;
  completedAt: Date | string | null;
};

export type Eligibility = "eligible" | "not_eligible" | "already_rated";

/** Can `userId` rate this appointment now? `hasRating`: a rating for the appointment already exists. */
export function rateEligibility(appointment: EligibilityInput | null, userId: string, hasRating: boolean, now = Date.now()): Eligibility {
  if (!appointment || appointment.status !== "completed" || !appointment.guardianUserId || appointment.guardianUserId !== userId) {
    return "not_eligible";
  }
  if (hasRating) return "already_rated";
  if (!appointment.completedAt) return "not_eligible";
  const completed = new Date(appointment.completedAt).getTime();
  if (Number.isNaN(completed) || now - completed > RATE_WINDOW_DAYS * DAY_MS) return "not_eligible";
  return "eligible";
}

export type EditCheck = "ok" | "not_owner" | "closed" | "locked";

/** Can `userId` change their rating? Within 7 days of rating it, unless an admin hid it. */
export function editCheck(rating: { guardianUserId: string; createdAt: Date | string; status: RatingStatus }, userId: string, now = Date.now()): EditCheck {
  if (rating.guardianUserId !== userId) return "not_owner";
  if (rating.status === "hidden") return "locked";
  if (now - new Date(rating.createdAt).getTime() > EDIT_WINDOW_DAYS * DAY_MS) return "closed";
  return "ok";
}

/**
 * Status after a guardian writes or edits a rating: an abusive comment waits for review; a rating the provider
 * reported stays in review until an admin decides; otherwise it is published.
 */
export function statusAfterWrite(
  needsReview: boolean,
  current?: { status: RatingStatus; reviewReason: ReviewReason | null },
): { status: RatingStatus; reviewReason: ReviewReason | null } {
  if (current?.status === "pending_review" && current.reviewReason === "provider_report") {
    return { status: "pending_review", reviewReason: "provider_report" };
  }
  if (needsReview) return { status: "pending_review", reviewReason: "abuse_screen" };
  return { status: "published", reviewReason: null };
}
