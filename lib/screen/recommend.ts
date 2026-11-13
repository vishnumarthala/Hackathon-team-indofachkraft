// Ticket 048 FR-6: which professional to see first, from the parent's worries (FR-5), the result and the age band.
// Pure, safe in the browser. DRAFT MAPPING PENDING CLINICAL REVIEW (NFR-2, docs/screen-recommendations.md).
//
//   speech            -> speech-language pathologist
//   movement          -> occupational therapist, physiotherapist (physio for movement only)
//   senses            -> occupational therapist
//   playing / social  -> developmental paediatrician, child psychologist (an evaluation first)
//   behaviour         -> child psychologist, ABA therapist
//   learning, 6-8 y   -> special educator, child psychologist (younger: developmental paediatrician, special educator)
//   "closer look"     -> developmental paediatrician (second, after the first worry's professional) and child psychologist
//   nothing to go on  -> paediatrician, developmental paediatrician
//
// Order: a playing/social worry puts the evaluation first; otherwise the worries in the order above; a "closer look"
// result (any band but `no_strong_signs`) brings the developmental paediatrician in second place.
import type { ProviderType } from "@/lib/providers/constants";
import type { CheckinBand } from "@/lib/clinical/checkin";
import type { ScreenConcern, StoredAgeBand } from "./questions";

const CONCERN_ORDER: readonly ScreenConcern[] = ["speech", "social", "movement", "senses", "behaviour", "learning"];

/** Ages 6-8 (and the old 6-9 / 10+ bands): learning and school go to a special educator. */
const SCHOOL_AGE: readonly StoredAgeBand[] = ["6-8y", "6-9y", "10y+"];

export function concernTypes(concern: ScreenConcern, ageBand: StoredAgeBand): ProviderType[] {
  switch (concern) {
    case "speech":
      return ["speech_language_pathologist"];
    case "movement":
      return ["occupational_therapist", "physiotherapist"];
    case "senses":
      return ["occupational_therapist"];
    case "social":
      return ["developmental_pediatrician", "child_psychologist"];
    case "behaviour":
      return ["child_psychologist", "aba_therapist"];
    case "learning":
      return SCHOOL_AGE.includes(ageBand) ? ["special_educator", "child_psychologist"] : ["developmental_pediatrician", "special_educator"];
  }
}

/** Why the first card is first: a worry the parent picked, the result, or (nothing picked, no signs) a check-up. */
export type RecommendationReason =
  | { kind: "concern"; concern: ScreenConcern }
  | { kind: "closer_look" }
  | { kind: "no_signs" };

export type Recommendation = {
  /** Provider types in order (no duplicates, at most MAX_TYPES); `/find` is prefiltered in this order. */
  types: ProviderType[];
  reason: RecommendationReason;
};

export const MAX_TYPES = 4;

export const isCloserLook = (band: CheckinBand | null): boolean => band !== null && band !== "no_strong_signs";

export function recommend(input: { ageBand: StoredAgeBand; concerns: readonly ScreenConcern[]; resultBand: CheckinBand | null }): Recommendation {
  const picked = CONCERN_ORDER.filter((c) => input.concerns.includes(c));
  const closer = isCloserLook(input.resultBand);
  const types: ProviderType[] = [];
  const add = (...list: ProviderType[]) => {
    for (const t of list) if (!types.includes(t)) types.push(t);
  };
  // Playing / social: an evaluation comes first.
  const ordered: ScreenConcern[] = picked.includes("social") ? ["social", ...picked.filter((c) => c !== "social")] : picked;
  for (const c of ordered) add(...concernTypes(c, input.ageBand));

  let reason: RecommendationReason;
  if (ordered.length > 0) reason = { kind: "concern", concern: ordered[0] };
  else if (closer) reason = { kind: "closer_look" };
  else reason = { kind: "no_signs" };

  if (closer) {
    if (!types.includes("developmental_pediatrician")) types.splice(Math.min(1, types.length), 0, "developmental_pediatrician");
    add("child_psychologist");
  }
  if (types.length === 0) add("pediatrician", "developmental_pediatrician");
  return { types: types.slice(0, MAX_TYPES), reason };
}

/** 048 FR-2: under 18 months, `/find` for paediatricians and developmental paediatricians. */
export const UNDER_18M_TYPES: readonly ProviderType[] = ["pediatrician", "developmental_pediatrician"];
/** 048 FR-1: over 8, a child's doctor or a child psychologist. */
export const OVER_8_TYPES: readonly ProviderType[] = ["child_psychologist", "pediatrician"];
