// Ticket 049 FR-3 / FR-6: what the follow-up agent sends to `answer_question` for a parent's words in any language.
// The live agent translates the parent's question into English (its prompt); the DEMO_MODE voice panel and the
// regression scripts use this lexicon-based stand-in, so a Telugu or Hindi conversation makes the same tool calls as
// the English one. Pure, safe in the browser.
import type { RedFlagCode } from "@/lib/clinical/checkin";
import type { Locale } from "@/lib/i18n/config";
import { detectRedFlag, matchCode, type Lexicon } from "../lexicon";

export type FollowupIntent = keyof Lexicon["followup"];

/** The English question the agent sends for each known intent (the 040 suggested questions, plus a medicine change). */
export const INTENT_QUESTIONS: Record<FollowupIntent, string> = {
  practice: "What should we practise this week?",
  nextReview: "When is the next review?",
  medicineHow: "How do I give the medicine?",
  medicineChange: "Can I double the syrup dose?",
};

/** The English sentence the agent sends for a red flag (the server's classifier answers 108/112 for each). */
export const RED_FLAG_QUESTIONS: Record<RedFlagCode, string> = {
  skill_regression: "My child has stopped talking and lost words.",
  self_injury: "My child is hurting himself.",
  seizure: "My child is having a seizure.",
  breathing: "My child is not breathing properly.",
  not_eating_drinking: "My child has stopped eating and drinking.",
  safety_concern: "My child is in danger.",
};

export type FollowupDemoScript = { language: Locale; lexicon: Pick<Lexicon, "followup" | "redFlags" | "answers"> };

/** The parent's words -> the `question` of `answer_question` (English for known intents and red flags). */
export function followupQuestionFor(script: FollowupDemoScript, utterance: string): string {
  const lexicon = script.lexicon as Lexicon;
  const redFlag = detectRedFlag(lexicon, utterance);
  if (redFlag) return RED_FLAG_QUESTIONS[redFlag];
  const intent = matchCode(utterance, lexicon.followup);
  if (intent) return INTENT_QUESTIONS[intent];
  return utterance.trim();
}
