// Ticket 049 FR-3 / FR-6: the DEMO_MODE voice check-in in the call language. No live call: the page shows the agent's
// first message and each question, the parent taps (or types) what they would say, and these rules turn it into the
// same `record_answer` / `record_red_flag` tool calls the live agent makes (lib/screen/client.ts screenClientTools).
// Pure, safe in the browser; the server sends the script for the call language with the session (catalogue text).
import type { RedFlagCode } from "@/lib/clinical/checkin";
import type { Locale } from "@/lib/i18n/config";
import { detectRedFlag, interpretAnswer, type Lexicon } from "../lexicon";

export type ScreenDemoScript = {
  language: Locale;
  /** The agent's first message, filled in (`{age_band}` in words). */
  first_message: string;
  /** `screen.urgent` in the call language, said after a red flag. */
  safety_message: string;
  closing: string;
  unclear: string;
  lexicon: Pick<Lexicon, "answers" | "redFlags">;
};

export type ScreenDemoQuestion = { id: string; kind: string; answers: readonly string[] };

export type ScreenToolCall =
  | { tool: "record_answer"; params: { item_id: string; answer: string } }
  | { tool: "record_red_flag"; params: { code: RedFlagCode } };

/**
 * One parent utterance -> the tool call the agent makes. A red flag described in words stops the check-in at any
 * question (FR-7 of 033); a yes to a red-flag question is recorded as its answer (the server stops the session).
 */
export function screenDemoTurn(script: ScreenDemoScript, question: ScreenDemoQuestion, utterance: string): ScreenToolCall | null {
  const lexicon = script.lexicon as Lexicon;
  const answer = interpretAnswer(lexicon, utterance, question.answers);
  if (question.kind === "red_flag" && answer) return { tool: "record_answer", params: { item_id: question.id, answer } };
  const redFlag = detectRedFlag(lexicon, utterance);
  if (redFlag) return { tool: "record_red_flag", params: { code: redFlag } };
  if (answer) return { tool: "record_answer", params: { item_id: question.id, answer } };
  return null;
}

/** The first synonym of each answer code (the reply buttons in the call language). */
export function answerWords(script: ScreenDemoScript, scale: readonly string[]): { code: string; word: string }[] {
  const answers = script.lexicon.answers as Record<string, string>;
  return scale.filter((code) => code in answers).map((code) => ({ code, word: answers[code].split(",")[0].trim() }));
}
