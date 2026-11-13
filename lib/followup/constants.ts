// Ticket 040: follow-up agent ("ask about my child's plan"). Pure constants, schemas and safety checks; safe in the
// browser (the chat UI) and on the server. Fixed answers are English (the agent answers in English, UI chrome is
// translated); they are also the exact sentences the voice agent must speak (docs/elevenlabs-followup-agent.md).
import { z } from "zod";
import { normalizeText } from "@/lib/clinical/red-flags";
import { URGENT_MESSAGE } from "@/lib/screen/questions";

export const FOLLOWUP_AGENT_NAME = "DoctorNearMe Follow-up";

/** FR-2: questions per guardian per rolling 24 hours (text and voice together; red-flag answers never count). */
export const DAILY_QUESTION_LIMIT = 30;
/** FR-5: a voice session accepts tool calls for 15 minutes. */
export const AGENT_SESSION_TTL_MS = 15 * 60_000;
/** Tool calls per voice session (the daily limit applies as well). */
export const MAX_TOOL_CALLS = 20;
/** The live call is ended by the page after this long (the agent is configured with the same limit). */
export const VOICE_MAX_MINUTES = 15;
/** FR-6: stored questions are deleted after 90 days (lib/privacy/retention.ts, overridable). */
export const FOLLOWUP_RETENTION_DAYS = 90;
/** NFR-2: the model call is abandoned after this long (the route then answers 502). */
export const MODEL_TIMEOUT_MS = 5_500;

export const NOT_FOUND_ANSWER = "I couldn't find that in your child's shared plans. Please ask your provider using Messages.";
export const MEDICINE_ANSWER = "Please don't change any medicine without talking to the prescriber.";
export const DIAGNOSIS_ANSWER = "I can't say whether your child has a condition. Please ask your provider using Messages.";
/** FR-3: the 033 safety message, word for word. */
export const RED_FLAG_ANSWER = URGENT_MESSAGE;

export const MESSAGES_PATH = "/family/messages";

/** FR-4: suggested questions (English, like the answers; the agent understands English only). */
export const SUGGESTED_QUESTIONS = ["What should we practise this week?", "When is the next review?", "How do I give the medicine?"] as const;

export const SAFETY_KINDS = ["red_flag", "medical_advice"] as const;
export type FollowupSafety = (typeof SAFETY_KINDS)[number];

export const CITED_ENTITY_TYPES = ["iep_plan", "home_program", "report", "assessment", "prescription"] as const;
export type CitedEntityType = (typeof CITED_ENTITY_TYPES)[number];

export function isCitedEntityType(value: unknown): value is CitedEntityType {
  return typeof value === "string" && (CITED_ENTITY_TYPES as readonly string[]).includes(value);
}

export const FollowupCitationSchema = z.object({
  entity_type: z.enum(CITED_ENTITY_TYPES),
  entity_id: z.string().uuid(),
  version: z.number().int().positive(),
  label: z.string(),
  excerpt: z.string(),
});
export type FollowupCitation = z.infer<typeof FollowupCitationSchema>;

export type FollowupAnswer = {
  found: boolean;
  answer: string;
  citations: FollowupCitation[];
  safety?: FollowupSafety;
};

export type FollowupChannel = "text" | "voice";

export type FollowupHistoryItem = FollowupAnswer & { id: string; question: string; channel: FollowupChannel; created_at: string };

export const QuestionSchema = z.object({
  question: z
    .string({ error: "Question must be text" })
    .trim()
    .min(3, "Question must be at least 3 characters")
    .max(500, "Question must be at most 500 characters"),
});

/** Where a citation chip opens: the cited published document at the cited version (guardian-only page). */
export function citationHref(childId: string, c: Pick<FollowupCitation, "entity_type" | "entity_id" | "version">): string {
  return `/family/children/${childId}/ask/sources/${c.entity_type}/${c.entity_id}/${c.version}`;
}

export function fixedAnswer(kind: "not_found" | "medicine" | "diagnosis" | "red_flag"): FollowupAnswer {
  switch (kind) {
    case "not_found":
      return { found: false, answer: NOT_FOUND_ANSWER, citations: [] };
    case "medicine":
      return { found: false, answer: MEDICINE_ANSWER, citations: [], safety: "medical_advice" };
    case "diagnosis":
      return { found: false, answer: DIAGNOSIS_ANSWER, citations: [], safety: "medical_advice" };
    case "red_flag":
      return { found: false, answer: RED_FLAG_ANSWER, citations: [], safety: "red_flag" };
  }
}

/** The UI shows a `Messages` link under these answers (not found, medicine and condition questions). */
export function needsMessagesLink(a: Pick<FollowupAnswer, "found" | "safety">): boolean {
  return a.safety !== "red_flag" && (!a.found || a.safety === "medical_advice");
}

const MEDICINE_NOUN =
  "(?:dose|doses|dosage|dosing|medicine|medicines|medication|medications|meds|syrup|tablet|tablets|pill|pills|drops|capsule|capsules|mg|ml|antibiotic|antibiotics|prescription|inhaler|paracetamol|ibuprofen|melatonin|risperidone|methylphenidate|aripiprazole)";
const CHANGE_VERB =
  "(?:double|doubling|triple|increase|increasing|raise|decrease|decreasing|reduce|reducing|lower|lowering|halve|half|cut|stop|stopping|quit|discontinue|skip|skipping|miss|missed|change|changing|adjust|adjusting|switch|switching|replace|substitute|extra|more|less|another|add|adding|start|starting|crush|split|taper|wean|repeat)";

const MEDICINE_CHANGE = [
  new RegExp(`\\b${CHANGE_VERB}\\b.{0,40}\\b${MEDICINE_NOUN}\\b`),
  new RegExp(
    `\\b${MEDICINE_NOUN}\\b.{0,40}\\b(?:double|doubled|increase|increased|decrease|decreased|reduce|reduced|stop|stopped|skip|skipped|change|changed|halved|more|less|extra|twice as)\\b`,
  ),
  // Adding another medicine: "can I also give paracetamol", "give it together with ...".
  new RegExp(`\\b(?:also|too|as well|together with|along with|instead of|with (?:his|her|the) other)\\b.{0,40}\\b${MEDICINE_NOUN}\\b`),
  new RegExp(`\\b${MEDICINE_NOUN}\\b.{0,40}\\b(?:also|too|as well|together with|along with|instead)\\b`),
  /\b(?:can|should|may|could)\s+(?:i|we)\s+(?:give|use|try)\s+(?:him|her|them|my child)?\s*(?:some\s+|a\s+)?(?:paracetamol|ibuprofen|melatonin|antibiotics?|cough syrup|crocin|calpol|dolo)\b/,
];

/** FR-2: questions about changing, stopping or adding medicines or doses get the fixed medicine answer. */
export function isMedicineChangeQuestion(text: string): boolean {
  const t = normalizeText(text);
  return MEDICINE_CHANGE.some((re) => re.test(t));
}

const DIAGNOSIS = [
  /\bdiagnos/,
  /\b(?:does|do|could|might|may)\s+(?:he|she|they|my child|my son|my daughter|the child|\w+)\s+have\s+(?:autism|asd|adhd|add|cerebral palsy|dyslexia|down syndrome|a disorder|a condition|a disability|a syndrome|an intellectual disability|epilepsy)/,
  /\b(?:is|are)\s+(?:he|she|they|my child|my son|my daughter|\w+)\s+(?:autistic|disabled|on the spectrum|hyperactive)/,
  /\bwhat\s+(?:condition|disorder|disease|illness)\s+(?:does|do)\b/,
];

/** FR-2 "never diagnose": questions asking whether the child has a condition get a fixed referral answer. */
export function isDiagnosisQuestion(text: string): boolean {
  const t = normalizeText(text);
  return DIAGNOSIS.some((re) => re.test(t));
}

const ANSWER_CHANGES_MEDICINE = new RegExp(
  `\\b(?:you can|you could|you may|you should|try to|try|it is fine to|it's fine to|it is okay to|it's okay to|ok to|safe to)\\s+(?:\\w+\\s+){0,3}${CHANGE_VERB}\\b`,
);

/** Post-check of a model answer: advice to change a medicine is replaced by the fixed medicine answer. */
export function answerSuggestsMedicineChange(answer: string): boolean {
  const t = normalizeText(answer);
  return ANSWER_CHANGES_MEDICINE.test(t) && new RegExp(`\\b${MEDICINE_NOUN}\\b`).test(t);
}
