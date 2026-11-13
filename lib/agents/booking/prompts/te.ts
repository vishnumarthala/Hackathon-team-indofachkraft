// Ticket 049 FR-2: the booking agent in Telugu (language preset `te`). Native-speaker review: messages/REVIEW.md
// (`voiceAgents.*`, `screen.urgent`, `voiceBooking.confirm`) and the language review checklist in docs/elevenlabs-booking-agent.md.
import te from "@/messages/te.json";
import { toAgentTemplate } from "../../languages";
import { PROMPT_LANGUAGES } from "../../prompt-languages";
import type { AgentPrompt } from "../../prompts";
import { bookingSystemPrompt } from "./template";

export const TE: AgentPrompt = {
  language: "te",
  firstMessage: toAgentTemplate(te.voiceAgents.booking.firstMessage),
  safetyMessage: te.screen.urgent,
  systemPrompt: bookingSystemPrompt({
    lang: PROMPT_LANGUAGES.te,
    safetyMessage: te.screen.urgent,
    lexicon: te.voiceAgents.lexicon,
    confirmLabel: te.voiceBooking.confirm,
    demoNotice: te.voiceAgents.booking.demo.demoNotice,
  }),
};
