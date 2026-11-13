// Ticket 033: the public developmental check-in (/screen). Pure and safe in the browser: age bands, the question
// list per band (024's ISAA_PARENT_CHECKIN, red-flag questions first), the result shape and the fixed copy.
// Question text stays English until clinically reviewed translations exist (018 D-4); the UI chrome is translated.
import { z } from "zod";
import {
  CHECKIN,
  isCheckinAnswer,
  isRedFlagAnswer,
  RED_FLAG_CODES,
  type CheckinBand,
  type CheckinDomain,
  type CheckinDomainScore,
  type RedFlagCode,
} from "@/lib/clinical/checkin";

/** FR-1: the bands a parent picks on the page, mapped to the instrument's age bands (024). */
export const SCREEN_AGE_BANDS = ["18-36m", "3-5y", "6-9y", "10y+"] as const;
export type ScreenAgeBand = (typeof SCREEN_AGE_BANDS)[number];

export const INSTRUMENT_BAND: Record<ScreenAgeBand, string> = {
  "18-36m": "18-35m",
  "3-5y": "36-71m",
  "6-9y": "72-215m",
  "10y+": "72-215m",
};

export const SCREEN_MODES = ["voice", "form"] as const;
export type ScreenMode = (typeof SCREEN_MODES)[number];

/** FR-4: a session accepts answers for 2 hours. */
export const SCREEN_SESSION_TTL_MS = 2 * 60 * 60 * 1000;
/** FR-5: unsaved sessions are deleted after 30 days (lib/privacy/retention.ts). */
export const UNSAVED_RETENTION_DAYS = 30;
/** FR-4: new sessions per IP per hour. */
export const SESSIONS_PER_HOUR = 5;
/** FR-3, lowered by 051 FR-6 (was 8): the voice agent's maximum conversation length (= the reserved minutes). */
export const VOICE_MAX_MINUTES = 6;

/** FR-7: the only thing shown after a red flag (no band, no providers, no booking). */
export const URGENT_MESSAGE =
  "Please get help now. Call 108 for an ambulance or 112 for emergencies. If your child is not in immediate danger, contact your child's doctor today.";
export const NOT_A_DIAGNOSIS = CHECKIN.disclaimer;

/** FR-6: provider types the result page searches for. */
export const SUGGESTED_PROVIDER_TYPES = [
  "developmental_pediatrician",
  "child_psychologist",
  "speech_language_pathologist",
  "occupational_therapist",
] as const;

export type ScreenQuestion = {
  id: string;
  kind: "red_flag" | "question";
  text: string;
  answers: readonly string[];
  /** Red-flag questions only. */
  code?: RedFlagCode;
};

export function isScreenAgeBand(value: unknown): value is ScreenAgeBand {
  return typeof value === "string" && (SCREEN_AGE_BANDS as readonly string[]).includes(value);
}

/** FR-1 / FR-3: red-flag questions first, then the questions for the age band, in instrument order. */
export function screenQuestions(ageBand: ScreenAgeBand): ScreenQuestion[] {
  const band = INSTRUMENT_BAND[ageBand];
  return [
    ...CHECKIN.red_flags.map((r) => ({
      id: r.id,
      kind: "red_flag" as const,
      text: r.text_en,
      answers: CHECKIN.red_flag_answer_scale,
      code: r.code,
    })),
    ...CHECKIN.questions
      .filter((q) => q.age_bands.includes(band))
      .map((q) => ({ id: q.id, kind: "question" as const, text: q.text_en, answers: q.answer_scale })),
  ];
}

/** Valid answer for an item of this band's question list (red flags: no/yes; questions: never..always). */
export function isValidScreenAnswer(questions: ScreenQuestion[], itemId: string, value: unknown): boolean {
  const q = questions.find((x) => x.id === itemId);
  if (!q) return false;
  return q.kind === "red_flag" ? isRedFlagAnswer(value) : isCheckinAnswer(value);
}

export function redFlagCodeForItem(itemId: string): RedFlagCode | null {
  return CHECKIN.red_flags.find((r) => r.id === itemId)?.code ?? null;
}

/** Item ids of the band's list still unanswered, in list order. */
export function missingScreenItems(questions: ScreenQuestion[], answers: Record<string, unknown>): string[] {
  return questions.filter((q) => !isValidScreenAnswer(questions, q.id, answers[q.id])).map((q) => q.id);
}

/** FR-3: the `{{questions}}` dynamic variable: a numbered list with the item ids the agent passes back. */
export function agentQuestionList(questions: ScreenQuestion[]): string {
  return questions
    .map((q, i) => {
      const scale = q.kind === "red_flag" ? "red flag, yes/no" : "never/sometimes/often/always";
      return `${i + 1}. [${q.id}] (${scale}) ${q.text}`;
    })
    .join("\n");
}

export type DomainLevel = "few_signs" | "some_signs" | "more_signs";
export const DOMAIN_LEVELS: readonly DomainLevel[] = ["few_signs", "some_signs", "more_signs"];

/**
 * Draft thresholds pending clinical review (rd.md open question): the domain's share of its maximum points, cut at
 * the same proportions as 024's total bands (10/45 -> some signs, 20/45 -> more signs), so a domain reads like the
 * overall band would if every domain answered the same way.
 */
const SOME_FROM = (CHECKIN.scoring.bands.find((b) => b.id === "discuss_with_professional")?.min ?? 10) / CHECKIN.scoring.max_total;
const MORE_FROM = (CHECKIN.scoring.bands.find((b) => b.id === "see_professional_soon")?.min ?? 20) / CHECKIN.scoring.max_total;

export function domainLevel(d: Pick<CheckinDomainScore, "points" | "max">): DomainLevel {
  if (d.max === 0) return "few_signs";
  const ratio = d.points / d.max;
  if (ratio >= MORE_FROM - 1e-9) return "more_signs";
  if (ratio >= SOME_FROM - 1e-9) return "some_signs";
  return "few_signs";
}

/** FR-4 `finish` response. A red flag has no band and no domains. */
export type ScreenResult = {
  result_band: CheckinBand | null;
  domains: { domain: CheckinDomain; level: DomainLevel }[];
  red_flag: boolean;
  message: string;
};

/** FR-6 headlines (English contract; the page shows the translated `screen.result.headlines.*`). */
export const RESULT_HEADLINES: Record<CheckinBand, string> = {
  no_strong_signs: "No strong signs from this check-in",
  discuss_with_professional: "Some areas are worth discussing with a professional",
  see_professional_soon: "Please see a professional soon",
};

export function redFlagResult(): ScreenResult {
  return { result_band: null, domains: [], red_flag: true, message: URGENT_MESSAGE };
}

export type { CheckinBand, CheckinDomain, RedFlagCode };

// ---------- request bodies (FR-4, FR-8) ----------

/** ElevenLabs conversation ids are opaque ASCII ids (e.g. `conv_...`). */
const ConversationId = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/, { error: "Invalid conversation id" });

export const SCREEN_ANSWER_VALUES = ["never", "sometimes", "often", "always", "no", "yes"] as const;

export const CreateSessionSchema = z.object({
  age_band: z.enum(SCREEN_AGE_BANDS, { error: "Choose your child's age" }),
  mode: z.enum(SCREEN_MODES, { error: "mode must be voice or form" }),
});

export const AnswersSchema = z.object({
  answers: z
    .array(
      z.object({
        item_id: z.string().max(50),
        answer: z.enum(SCREEN_ANSWER_VALUES, { error: "Unknown answer" }),
      }),
    )
    .min(1, { error: "Send at least one answer" })
    .max(50),
  conversation_id: ConversationId.optional(),
});

export const RedFlagSchema = z.object({
  code: z.enum(RED_FLAG_CODES, { error: "Unknown red flag" }),
  conversation_id: ConversationId.optional(),
});

export const FinishSchema = z.object({ conversation_id: ConversationId.optional() });

export const SaveResultSchema = z.object({
  session_id: z.uuid({ error: "Invalid check-in" }),
  child_id: z.uuid({ error: "Choose a child" }),
});
