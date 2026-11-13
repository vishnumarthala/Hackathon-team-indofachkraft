// Ticket 049 FR-2: the booking agent in English (the agent's base language; dashboard prompt unchanged).
import en from "@/messages/en.json";
import { toAgentTemplate } from "../../languages";
import { PROMPT_LANGUAGES } from "../../prompt-languages";
import type { AgentPrompt } from "../../prompts";
import { bookingSystemPrompt } from "./template";

export const EN: AgentPrompt = {
  language: "en",
  firstMessage: toAgentTemplate(en.voiceAgents.booking.firstMessage),
  safetyMessage: en.screen.urgent,
  systemPrompt: bookingSystemPrompt({
    lang: PROMPT_LANGUAGES.en,
    safetyMessage: en.screen.urgent,
    lexicon: en.voiceAgents.lexicon,
    confirmLabel: en.voiceBooking.confirm,
    demoNotice: en.voiceAgents.booking.demo.demoNotice,
  }),
};
