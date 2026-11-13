// Ticket 049 FR-2 / FR-3 (server only): the follow-up tool answers in the call language. The pipeline
// (lib/followup/answer.ts) stays English, so the red-flag classifier, the medicine and condition rules and the
// citation checks run unchanged on the English question and answer. For a Hindi or Telugu session:
//   - fixed answers (108/112, medicine, condition, not found) are replaced by their reviewed translation from
//     messages/{hi,te}.json and must be said word for word (`translate: false`);
//   - a model answer stays English, already checked, with `translate: true`: the agent translates it faithfully.
import type { Locale } from "@/lib/i18n/config";
import { DIAGNOSIS_ANSWER, MEDICINE_ANSWER, NOT_FOUND_ANSWER, RED_FLAG_ANSWER } from "@/lib/followup/constants";
import { agentTexts, urgentMessage } from "../call-language";

/** The fixed follow-up answers in a language (English = the 040 constants). */
export function fixedAnswers(language: Locale): Record<"red_flag" | "medicine" | "condition" | "not_found", string> {
  const answers = agentTexts(language).followup.answers;
  return { red_flag: urgentMessage(language), medicine: answers.medicine, condition: answers.condition, not_found: answers.notFound };
}

const ENGLISH_FIXED: Record<string, keyof ReturnType<typeof fixedAnswers>> = {
  [RED_FLAG_ANSWER]: "red_flag",
  [MEDICINE_ANSWER]: "medicine",
  [DIAGNOSIS_ANSWER]: "condition",
  [NOT_FOUND_ANSWER]: "not_found",
};

/** A successful `answer_question` body for a session language. Error bodies and English sessions are unchanged. */
export function localizeToolAnswer(body: Record<string, unknown>, language: Locale): Record<string, unknown> {
  if (language === "en" || typeof body.answer !== "string") return body;
  const fixed = ENGLISH_FIXED[body.answer];
  if (fixed) return { ...body, answer: fixedAnswers(language)[fixed], language, translate: false };
  return { ...body, language, translate: true, answer_language: "en" };
}
