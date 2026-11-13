// Ticket 024 FR-4: the ISAA-derived parent developmental check-in (ISAA_PARENT_CHECKIN). Pure, safe in the
// browser; also used by the public screen (033). Copy and thresholds are drafts pending clinical review
// (rd.md "Open questions"). Question text is English only until a clinical translation review (018 D-4).
import checkinJson from "@/schemas/isaa-parent-checkin.json";

export const CHECKIN_ANSWERS = ["never", "sometimes", "often", "always"] as const;
export type CheckinAnswer = (typeof CHECKIN_ANSWERS)[number];
export const RED_FLAG_ANSWERS = ["no", "yes"] as const;
export type RedFlagAnswer = (typeof RED_FLAG_ANSWERS)[number];

export const RED_FLAG_CODES = [
  "skill_regression",
  "self_injury",
  "seizure",
  "breathing",
  "not_eating_drinking",
  "safety_concern",
] as const;
export type RedFlagCode = (typeof RED_FLAG_CODES)[number];

export const CHECKIN_BANDS = ["no_strong_signs", "discuss_with_professional", "see_professional_soon"] as const;
export type CheckinBand = (typeof CHECKIN_BANDS)[number];

export type CheckinDomain = "social" | "emotional" | "speech" | "behaviour" | "sensory" | "cognitive";

export type CheckinQuestion = {
  id: string;
  domain: CheckinDomain;
  text_en: string;
  answer_scale: CheckinAnswer[];
  /** true = "never" is the concern (positively worded question). */
  reverse: boolean;
  isaa_items: number[];
  age_bands: string[];
};

export type CheckinRedFlagQuestion = { id: string; code: RedFlagCode; text_en: string };

export type CheckinDefinition = {
  instrument: "ISAA_PARENT_CHECKIN";
  version: string;
  title: string;
  disclaimer: string;
  answer_scale: CheckinAnswer[];
  answer_labels: Record<CheckinAnswer, string>;
  age_bands: { id: string; min_months: number; max_months: number }[];
  domains: { id: CheckinDomain; name: string }[];
  questions: CheckinQuestion[];
  red_flag_answer_scale: RedFlagAnswer[];
  red_flags: CheckinRedFlagQuestion[];
  scoring: {
    points: Record<CheckinAnswer, number>;
    reverse_points: Record<CheckinAnswer, number>;
    max_total: number;
    bands: { id: CheckinBand; min: number; max: number }[];
    any_red_flag_band: CheckinBand;
  };
  result_copy: Record<CheckinBand, string>;
  urgent_copy: string;
};

export const CHECKIN = checkinJson as CheckinDefinition;

export const CHECKIN_DISCLAIMER = CHECKIN.disclaimer;
export const URGENT_COPY = CHECKIN.urgent_copy;

/** Every item a guardian must answer, in form order: the 15 questions, then the red-flag questions. */
export const CHECKIN_ITEM_IDS: string[] = [...CHECKIN.questions.map((q) => q.id), ...CHECKIN.red_flags.map((r) => r.id)];

export type CheckinAnswers = Record<string, unknown>;

export function isCheckinAnswer(value: unknown): value is CheckinAnswer {
  return typeof value === "string" && (CHECKIN_ANSWERS as readonly string[]).includes(value);
}

export function isRedFlagAnswer(value: unknown): value is RedFlagAnswer {
  return typeof value === "string" && (RED_FLAG_ANSWERS as readonly string[]).includes(value);
}

/** Valid answer for an item id (scale answer for questions, yes/no for red flags); false for unknown ids. */
export function isValidCheckinValue(itemId: string, value: unknown): boolean {
  if (CHECKIN.questions.some((q) => q.id === itemId)) return isCheckinAnswer(value);
  if (CHECKIN.red_flags.some((r) => r.id === itemId)) return isRedFlagAnswer(value);
  return false;
}

/** Red-flag codes answered `yes`, in definition order. */
export function checkinRedFlags(answers: CheckinAnswers): RedFlagCode[] {
  return CHECKIN.red_flags.filter((r) => answers[r.id] === "yes").map((r) => r.code);
}

/** Item ids that still need a valid answer, in form order. */
export function missingCheckinItems(answers: CheckinAnswers): string[] {
  return CHECKIN_ITEM_IDS.filter((id) => !isValidCheckinValue(id, answers[id]));
}

export type CheckinDomainScore = { domain: CheckinDomain; points: number; max: number; answered: number };

export type CheckinScore = {
  instrument: "ISAA_PARENT_CHECKIN";
  version: string;
  complete: boolean;
  answered: number;
  total: number;
  max_total: number;
  /** null until every question and red-flag question is answered. */
  band: CheckinBand | null;
  red_flags: RedFlagCode[];
  by_domain: CheckinDomainScore[];
  /** Fixed copy for the band (ends with the disclaimer); null while incomplete. */
  result_text: string | null;
  disclaimer: string;
};

export function questionPoints(question: Pick<CheckinQuestion, "reverse">, answer: CheckinAnswer): number {
  return (question.reverse ? CHECKIN.scoring.reverse_points : CHECKIN.scoring.points)[answer];
}

export function bandForTotal(total: number): CheckinBand {
  const band = CHECKIN.scoring.bands.find((b) => total >= b.min && total <= b.max);
  if (!band) throw new Error(`Check-in total out of range: ${total}`);
  return band.id;
}

/** Scores a (possibly partial) answer set. Any red flag answered `yes` gives `see_professional_soon`. */
export function scoreCheckin(answers: CheckinAnswers): CheckinScore {
  let total = 0;
  let answered = 0;
  const domains = new Map<CheckinDomain, CheckinDomainScore>(
    CHECKIN.domains.map((d) => [d.id, { domain: d.id, points: 0, max: 0, answered: 0 }]),
  );
  for (const question of CHECKIN.questions) {
    const domain = domains.get(question.domain) as CheckinDomainScore;
    domain.max += 3;
    const answer = answers[question.id];
    if (!isCheckinAnswer(answer)) continue;
    const points = questionPoints(question, answer);
    total += points;
    answered += 1;
    domain.points += points;
    domain.answered += 1;
  }
  const red_flags = checkinRedFlags(answers);
  const complete = missingCheckinItems(answers).length === 0;
  const band = complete ? (red_flags.length > 0 ? CHECKIN.scoring.any_red_flag_band : bandForTotal(total)) : null;
  return {
    instrument: "ISAA_PARENT_CHECKIN",
    version: CHECKIN.version,
    complete,
    answered,
    total,
    max_total: CHECKIN.scoring.max_total,
    band,
    red_flags,
    by_domain: [...domains.values()],
    result_text: band ? CHECKIN.result_copy[band] : null,
    disclaimer: CHECKIN.disclaimer,
  };
}
