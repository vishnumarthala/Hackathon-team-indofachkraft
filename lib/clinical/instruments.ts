// Ticket 024 FR-1: instrument registry (typed view of `clinical_instruments`). Pure, safe in the browser.
//
// Definitions are bundled from schemas/*.json; the migration seeds the same JSON into `clinical_instruments`
// (tests/clinical-contracts.test.ts fails when they drift) and `facts.instrument` is a foreign key to it.
// Adding an instrument: add schemas/<name>.json, a row in a new migration, an entry in INSTRUMENTS below and,
// if it is scored, a branch in `score()`. New standardised instruments need a licensing review first.
import caseSheetJson from "@/schemas/case-sheet.json";
import isaaJson from "@/schemas/isaa.json";
import { CHECKIN, scoreCheckin, type CheckinAnswers, type CheckinScore } from "@/lib/clinical/checkin";
import { MCHAT, scoreMchat, type MchatScore } from "@/lib/clinical/mchat";
import { scoreIsaa, type IsaaScore, type ScoringFact } from "@/lib/scoring";

// 048: MCHAT_RF is registered (with placeholder item text) but only used by /screen when MCHAT_LICENSED=true.
export const INSTRUMENT_KEYS = ["ISAA", "CASE_SHEET", "ISAA_PARENT_CHECKIN", "MCHAT_RF"] as const;
export type InstrumentKey = (typeof INSTRUMENT_KEYS)[number];
export type InstrumentKind = "provider_rated" | "guardian_questionnaire" | "case_sheet";

export type InstrumentScale =
  | { type: "rating"; options: { value: number; label: string }[] }
  | { type: "choice"; options: { value: string; label: string }[] }
  | { type: "boolean" }
  | { type: "integer" }
  | { type: "text" };

export type InstrumentItem = {
  id: string;
  /** Domain id, or null for unscored fields (case sheet). */
  domain: string | null;
  /** English text (clinical translation review pending). */
  text: string;
  scale: InstrumentScale;
  /** true = the low end of the scale is the concern (positively worded). */
  reverse?: boolean;
  /** Red-flag codes this item raises (ISAA `lost_speech`/`self_injury`, check-in `skill_regression`, ...). */
  red_flag?: string[];
};

export type InstrumentDefinition = {
  key: InstrumentKey;
  version: string;
  kind: InstrumentKind;
  title: string;
  items: InstrumentItem[];
};

const yesNo: InstrumentScale = {
  type: "choice",
  options: [
    { value: "no", label: "No" },
    { value: "yes", label: "Yes" },
  ],
};

function isaaDefinition(): InstrumentDefinition {
  const scale: InstrumentScale = { type: "rating", options: isaaJson.scale.map((s) => ({ value: s.value, label: s.label })) };
  const redFlags = isaaJson.red_flag_items as Record<string, string>;
  return {
    key: "ISAA",
    version: "1",
    kind: "provider_rated",
    title: "Indian Scale for Assessment of Autism (ISAA)",
    items: isaaJson.items.map((item) => ({
      id: String(item.id),
      domain: item.domain,
      text: item.text,
      scale,
      ...(redFlags[String(item.id)] ? { red_flag: [redFlags[String(item.id)]] } : {}),
    })),
  };
}

function caseSheetDefinition(): InstrumentDefinition {
  return {
    key: "CASE_SHEET",
    version: "1",
    kind: "case_sheet",
    title: "Intake case sheet",
    items: caseSheetJson.fields.map((field) => ({
      id: field.id,
      domain: null,
      text: field.label,
      scale: { type: field.type === "boolean" ? "boolean" : field.type === "integer" ? "integer" : "text" } as InstrumentScale,
    })),
  };
}

function checkinDefinition(): InstrumentDefinition {
  const scale: InstrumentScale = {
    type: "choice",
    options: CHECKIN.answer_scale.map((value) => ({ value, label: CHECKIN.answer_labels[value] })),
  };
  return {
    key: "ISAA_PARENT_CHECKIN",
    version: CHECKIN.version,
    kind: "guardian_questionnaire",
    title: CHECKIN.title,
    items: [
      ...CHECKIN.questions.map((q) => ({ id: q.id, domain: q.domain, text: q.text_en, scale, reverse: q.reverse })),
      ...CHECKIN.red_flags.map((r) => ({ id: r.id, domain: null, text: r.text_en, scale: yesNo, red_flag: [r.code] })),
    ],
  };
}

function mchatDefinition(): InstrumentDefinition {
  return {
    key: "MCHAT_RF",
    version: MCHAT.version,
    kind: "guardian_questionnaire",
    title: MCHAT.title,
    // The 20 screening items; the optional Follow-Up items are in the raw definition (`follow_up.items`).
    items: MCHAT.items.map((item) => ({ id: item.id, domain: null, text: item.text_en, scale: yesNo, reverse: item.risk_answer === "yes" })),
  };
}

const INSTRUMENTS: Record<InstrumentKey, InstrumentDefinition> = {
  ISAA: isaaDefinition(),
  CASE_SHEET: caseSheetDefinition(),
  ISAA_PARENT_CHECKIN: checkinDefinition(),
  MCHAT_RF: mchatDefinition(),
};

/** Raw JSON definition as stored in `clinical_instruments.definition`. */
export const INSTRUMENT_SOURCES: Record<InstrumentKey, unknown> = {
  ISAA: isaaJson,
  CASE_SHEET: caseSheetJson,
  ISAA_PARENT_CHECKIN: CHECKIN,
  MCHAT_RF: MCHAT,
};

export function isInstrumentKey(value: unknown): value is InstrumentKey {
  return typeof value === "string" && (INSTRUMENT_KEYS as readonly string[]).includes(value);
}

export function getInstrument(key: InstrumentKey): InstrumentDefinition;
export function getInstrument(key: string): InstrumentDefinition | null;
export function getInstrument(key: string): InstrumentDefinition | null {
  return isInstrumentKey(key) ? INSTRUMENTS[key] : null;
}

export type InstrumentScore =
  | { key: "ISAA"; result: IsaaScore }
  | { key: "ISAA_PARENT_CHECKIN"; result: CheckinScore }
  | { key: "MCHAT_RF"; result: MchatScore };

/**
 * Scores an answer set. ISAA delegates to the unchanged `scoreIsaa` (lib/scoring.ts) with the facts as stored
 * (`{ item_id, value, status }`); the parent check-in takes `{ [item_id]: answer }`. CASE_SHEET is not scored.
 */
export function score(key: "ISAA", answers: ScoringFact[]): Extract<InstrumentScore, { key: "ISAA" }>;
export function score(key: "ISAA_PARENT_CHECKIN", answers: CheckinAnswers): Extract<InstrumentScore, { key: "ISAA_PARENT_CHECKIN" }>;
export function score(key: "MCHAT_RF", answers: CheckinAnswers): Extract<InstrumentScore, { key: "MCHAT_RF" }>;
export function score(key: InstrumentKey, answers: ScoringFact[] | CheckinAnswers): InstrumentScore;
export function score(key: InstrumentKey, answers: ScoringFact[] | CheckinAnswers): InstrumentScore {
  if (key === "ISAA") {
    if (!Array.isArray(answers)) throw new Error("ISAA is scored from facts: [{ item_id, value, status }]");
    return { key, result: scoreIsaa(answers) };
  }
  if (key === "ISAA_PARENT_CHECKIN") {
    if (Array.isArray(answers)) throw new Error("ISAA_PARENT_CHECKIN is scored from { item_id: answer }");
    return { key, result: scoreCheckin(answers) };
  }
  if (key === "MCHAT_RF") {
    if (Array.isArray(answers)) throw new Error("MCHAT_RF is scored from { item_id: answer }");
    return { key, result: scoreMchat(answers) };
  }
  throw new Error(`${key} is not a scored instrument`);
}
