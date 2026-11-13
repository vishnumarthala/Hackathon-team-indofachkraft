// Ticket 033: the public developmental check-in (/screen). Pure and safe in the browser: age bands, the question
// list per band (024's ISAA_PARENT_CHECKIN, red-flag questions first), the result shape and the fixed copy.
// Question text stays English until clinically reviewed translations exist (018 D-4); the UI chrome is translated.
// Ticket 048: children up to 8 only. New bands (`under-18m` milestones only, `18-30m`, `31-71m`, `6-8y`, `9y+` = "talk
// to a professional"); `18-30m` uses M-CHAT-R/F when MCHAT_LICENSED=true; a "what worries you most?" step; the
// result recommends provider types (lib/screen/recommend.ts). Stored sessions keep their old band values.
import { z } from "zod";
import {
  CHECKIN,
  checkinRedFlags,
  RED_FLAG_CODES,
  type CheckinBand,
  type CheckinDomain,
  type CheckinDomainScore,
  type RedFlagCode,
} from "@/lib/clinical/checkin";
import { followUpIdsFor, MCHAT, MCHAT_FOLLOW_UP_ANSWERS, scoreMchat, type MchatFollowUpResult, type MchatRisk } from "@/lib/clinical/mchat";
import type { Recommendation } from "./recommend";

/** 048 FR-1: the bands a parent picks on the page. `under-18m` and `9y+` get no questions (no session). */
export const SCREEN_AGE_BANDS = ["under-18m", "18-30m", "31-71m", "6-8y", "9y+"] as const;
export type ScreenAgeBand = (typeof SCREEN_AGE_BANDS)[number];

/** 048 FR-1: the bands that start a check-in session. */
export const QUESTION_AGE_BANDS = ["18-30m", "31-71m", "6-8y"] as const;
export type QuestionAgeBand = (typeof QUESTION_AGE_BANDS)[number];

/** 033 bands: no longer offered, but stored sessions keep them and still render (048 FR-1). */
export const LEGACY_AGE_BANDS = ["18-36m", "3-5y", "6-9y", "10y+"] as const;
export type LegacyAgeBand = (typeof LEGACY_AGE_BANDS)[number];

/** Every value `screen_sessions.age_band` can hold. */
export type StoredAgeBand = QuestionAgeBand | LegacyAgeBand;

/** Picked bands without questions: milestone guidance (`under-18m`) or the "up to 8" page (`9y+`). */
export type NoQuestionBand = Exclude<ScreenAgeBand, QuestionAgeBand>;

/** Session bands mapped to the ISAA-derived instrument's age bands (024). */
export const INSTRUMENT_BAND: Record<StoredAgeBand, string> = {
  "18-30m": "18-35m",
  "31-71m": "36-71m",
  "6-8y": "72-215m",
  "18-36m": "18-35m",
  "3-5y": "36-71m",
  "6-9y": "72-215m",
  "10y+": "72-215m",
};

/** What the voice agent hears as `{{age_band}}` (English agent; 049 adds hi/te). */
export const SPOKEN_AGE_BAND: Record<QuestionAgeBand, string> = {
  "18-30m": "18 to 30 months",
  "31-71m": "2 and a half to 5 years",
  "6-8y": "6 to 8 years",
};

/** 048 FR-3: the instruments a check-in session can use. */
export const SCREEN_INSTRUMENTS = ["ISAA_PARENT_CHECKIN", "MCHAT_RF"] as const;
export type ScreenInstrument = (typeof SCREEN_INSTRUMENTS)[number];

/** 048 FR-3: M-CHAT-R/F for 18-30 months only when licensed; otherwise (and for every other band) ISAA-derived. */
export function instrumentFor(ageBand: StoredAgeBand, mchatLicensed: boolean): ScreenInstrument {
  return ageBand === "18-30m" && mchatLicensed ? "MCHAT_RF" : "ISAA_PARENT_CHECKIN";
}

/** 048 FR-5: "What worries you most?" (multi-select, optional). Stored with the session as codes only. */
export const SCREEN_CONCERNS = ["speech", "social", "movement", "senses", "behaviour", "learning"] as const;
export type ScreenConcern = (typeof SCREEN_CONCERNS)[number];

/** `Learning and school` is not offered for toddlers (it is still accepted and mapped if sent). */
export function concernsFor(ageBand: QuestionAgeBand): readonly ScreenConcern[] {
  return ageBand === "18-30m" ? SCREEN_CONCERNS.filter((c) => c !== "learning") : SCREEN_CONCERNS;
}

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

export type ScreenQuestion = {
  id: string;
  /** `follow_up`: an M-CHAT-R/F Follow-Up item (pass/fail), asked only after a moderate result. */
  kind: "red_flag" | "question" | "follow_up";
  text: string;
  answers: readonly string[];
  /** Red-flag questions only. */
  code?: RedFlagCode;
};

export function isScreenAgeBand(value: unknown): value is ScreenAgeBand {
  return typeof value === "string" && (SCREEN_AGE_BANDS as readonly string[]).includes(value);
}

export function isQuestionAgeBand(value: unknown): value is QuestionAgeBand {
  return typeof value === "string" && (QUESTION_AGE_BANDS as readonly string[]).includes(value);
}

function redFlagQuestions(): ScreenQuestion[] {
  return CHECKIN.red_flags.map((r) => ({
    id: r.id,
    kind: "red_flag" as const,
    text: r.text_en,
    answers: CHECKIN.red_flag_answer_scale,
    code: r.code,
  }));
}

/**
 * FR-1 / FR-3 (033), 048 FR-1..FR-4: red-flag questions first (048 FR-8), then the questions of the instrument for
 * the band, in instrument order. `under-18m` and `9y+` have no questions.
 */
export function screenQuestions(ageBand: StoredAgeBand | ScreenAgeBand, instrument: ScreenInstrument = "ISAA_PARENT_CHECKIN"): ScreenQuestion[] {
  if (!(ageBand in INSTRUMENT_BAND)) return [];
  if (instrument === "MCHAT_RF") {
    return [
      ...redFlagQuestions(),
      ...MCHAT.items.map((i) => ({ id: i.id, kind: "question" as const, text: i.text_en, answers: MCHAT.answer_scale })),
    ];
  }
  const band = INSTRUMENT_BAND[ageBand as StoredAgeBand];
  return [
    ...redFlagQuestions(),
    ...CHECKIN.questions
      .filter((q) => q.age_bands.includes(band))
      .map((q) => ({ id: q.id, kind: "question" as const, text: q.text_en, answers: q.answer_scale })),
  ];
}

/** 048 FR-3: the optional M-CHAT-R/F Follow-Up items for a moderate result (the items that scored), else none. */
export function followUpQuestions(instrument: ScreenInstrument, answers: Record<string, unknown>): ScreenQuestion[] {
  if (instrument !== "MCHAT_RF") return [];
  const scored = scoreMchat(answers);
  if (!scored.follow_up.offered) return [];
  return followUpIdsFor(scored.at_risk_items).map((id) => {
    const item = MCHAT.follow_up.items.find((f) => f.id === id)!;
    return { id, kind: "follow_up" as const, text: item.text_en, answers: MCHAT_FOLLOW_UP_ANSWERS };
  });
}

/** Valid answer for an item of this question list (each question carries its own answer scale). */
export function isValidScreenAnswer(questions: ScreenQuestion[], itemId: string, value: unknown): boolean {
  const q = questions.find((x) => x.id === itemId);
  if (!q || typeof value !== "string") return false;
  return q.answers.includes(value);
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
      const scale = q.kind === "red_flag" ? "red flag, yes/no" : q.answers.join("/");
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

/** 048 FR-3: the M-CHAT-R/F part of a result (null for the ISAA-derived check-in). */
export type MchatResult = {
  risk: MchatRisk;
  /** Moderate only: the optional Follow-Up (`result` once answered; `questions` while it is still open). */
  follow_up: { offered: boolean; result: MchatFollowUpResult | null; questions: ScreenQuestion[] };
};

/** FR-4 `finish` response. A red flag has no band, no domains and no recommendation. */
export type ScreenResult = {
  result_band: CheckinBand | null;
  domains: { domain: CheckinDomain; level: DomainLevel }[];
  red_flag: boolean;
  message: string;
  /** 048: the instrument that produced the result. */
  instrument: ScreenInstrument;
  mchat: MchatResult | null;
  /** 048 FR-6: provider types in order, with the reason for the first one (null after a red flag). */
  recommendation: Recommendation | null;
};

/** FR-6 headlines (English contract; the page shows the translated `screen.result.headlines.*`). */
export const RESULT_HEADLINES: Record<CheckinBand, string> = {
  no_strong_signs: "No strong signs from this check-in",
  discuss_with_professional: "Some areas are worth discussing with a professional",
  see_professional_soon: "Please see a professional soon",
};

export function redFlagResult(instrument: ScreenInstrument = "ISAA_PARENT_CHECKIN"): ScreenResult {
  return { result_band: null, domains: [], red_flag: true, message: URGENT_MESSAGE, instrument, mchat: null, recommendation: null };
}

/** 048 FR-3: M-CHAT-R/F risk (after the optional Follow-Up) mapped to the check-in's three result bands. */
export function mchatBand(risk: MchatRisk, followUp: MchatFollowUpResult | null): CheckinBand {
  if (followUp) return followUp === "positive" ? "see_professional_soon" : "no_strong_signs";
  return risk === "low" ? "no_strong_signs" : risk === "moderate" ? "discuss_with_professional" : "see_professional_soon";
}

/** Red-flag codes answered `yes` in a stored answer set (both instruments share the red-flag items). */
export const answeredRedFlags = (answers: Record<string, unknown>): RedFlagCode[] => checkinRedFlags(answers);

export type { CheckinBand, CheckinDomain, RedFlagCode };

// ---------- request bodies (FR-4, FR-8) ----------

/** ElevenLabs conversation ids are opaque ASCII ids (e.g. `conv_...`). */
const ConversationId = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/, { error: "Invalid conversation id" });

export const SCREEN_ANSWER_VALUES = ["never", "sometimes", "often", "always", "no", "yes"] as const;

export const CreateSessionSchema = z.object({
  // 048 FR-1: only the bands with questions start a session (`under-18m` / `9y+` are handled on the page).
  age_band: z.enum(QUESTION_AGE_BANDS, { error: "Choose your child's age (up to 8 years)" }),
  mode: z.enum(SCREEN_MODES, { error: "mode must be voice or form" }),
  // 048 FR-5: codes only (no free text), de-duplicated.
  concerns: z
    .array(z.enum(SCREEN_CONCERNS, { error: "Unknown concern" }))
    .max(SCREEN_CONCERNS.length)
    .default([])
    .transform((list) => SCREEN_CONCERNS.filter((c) => list.includes(c))),
});

/** 048 FR-3: the M-CHAT-R/F Follow-Up answers (all at once). */
export const FollowUpSchema = z.object({
  answers: z
    .array(
      z.object({
        item_id: z.string().max(50),
        answer: z.enum(MCHAT_FOLLOW_UP_ANSWERS, { error: "Answer pass or fail" }),
      }),
    )
    .min(1, { error: "Send at least one answer" })
    .max(20),
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
