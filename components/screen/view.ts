// Ticket 033: pure view helpers for the check-in components (message keys for ids, button styles).
import type { CheckinBand } from "@/lib/clinical/checkin";
import type { DomainLevel, ScreenAgeBand, StoredAgeBand } from "@/lib/screen/questions";
import type { RecommendationReason } from "@/lib/screen/recommend";

/** Picker bands (048) and every stored band (033's old bands still render on saved check-ins). */
export const AGE_BAND_KEYS = {
  "under-18m": "under18m",
  "18-30m": "m18to30",
  "31-71m": "m31to71",
  "6-8y": "y6to8",
  "9y+": "y9plus",
  "18-36m": "m18to36",
  "3-5y": "y3to5",
  "6-9y": "y6to9",
  "10y+": "y10plus",
} as const satisfies Record<ScreenAgeBand | StoredAgeBand, string>;

/** 048 FR-6: message key (`screen.recommend.reasons.*`) for the first card's one-line reason. */
export function reasonKey(reason: RecommendationReason, firstType: string | undefined) {
  if (reason.kind === "closer_look") return "closerLook" as const;
  if (reason.kind === "no_signs") return "noSigns" as const;
  if (reason.concern === "learning") return firstType === "special_educator" ? ("learningSchool" as const) : ("learningYoung" as const);
  return reason.concern;
}

export const HEADLINE_KEYS = {
  no_strong_signs: "noStrongSigns",
  discuss_with_professional: "discussWithProfessional",
  see_professional_soon: "seeProfessionalSoon",
} as const satisfies Record<CheckinBand, string>;

export const LEVEL_KEYS = {
  few_signs: "fewSigns",
  some_signs: "someSigns",
  more_signs: "moreSigns",
} as const satisfies Record<DomainLevel, string>;

export const ANSWER_KEYS = ["never", "sometimes", "often", "always", "yes", "no"] as const;
export type AnswerKey = (typeof ANSWER_KEYS)[number];
export const isAnswerKey = (value: string): value is AnswerKey => (ANSWER_KEYS as readonly string[]).includes(value);

export const primaryButton =
  "inline-flex min-h-12 w-full items-center justify-center rounded-full bg-teal-700 px-6 py-3 text-base font-semibold text-white shadow hover:bg-teal-800 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-600/40 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto";
export const secondaryButton =
  "inline-flex min-h-12 w-full items-center justify-center rounded-full border border-slate-300 bg-white px-6 py-3 text-base font-semibold text-slate-900 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-600/30 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto";
export const smallButton =
  "inline-flex min-h-11 items-center justify-center rounded-xl border border-slate-300 bg-white px-4 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50";
