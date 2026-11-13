// Ticket 049 (server only): the DEMO_MODE voice check-in script for a call language, from the catalogue.
import type { Locale } from "@/lib/i18n/config";
import { SPOKEN_AGE_BAND, type QuestionAgeBand } from "@/lib/screen/questions";
import { agentTexts, urgentMessage } from "../call-language";
import { fillTemplate } from "../languages";
import type { ScreenDemoScript } from "./demo-script";

export function screenDemoScript(language: Locale, ageBand: QuestionAgeBand): ScreenDemoScript {
  const text = agentTexts(language);
  return {
    language,
    first_message: fillTemplate(text.screen.firstMessage, { age_band: SPOKEN_AGE_BAND[language][ageBand] }),
    safety_message: urgentMessage(language),
    closing: text.screen.demoClosing,
    unclear: text.screen.demoUnclear,
    lexicon: { answers: text.lexicon.answers, redFlags: text.lexicon.redFlags },
  };
}
