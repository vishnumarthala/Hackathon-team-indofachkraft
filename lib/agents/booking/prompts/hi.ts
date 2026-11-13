// Ticket 049 FR-2: the booking agent in Hindi (language preset `hi`). Native-speaker review: messages/REVIEW.md
// (`voiceAgents.*`, `screen.urgent`, `voiceBooking.confirm`) and the language review checklist in docs/elevenlabs-booking-agent.md.
import hi from "@/messages/hi.json";
import { toAgentTemplate } from "../../languages";
import { PROMPT_LANGUAGES } from "../../prompt-languages";
import type { AgentPrompt } from "../../prompts";
import { bookingSystemPrompt } from "./template";

export const HI: AgentPrompt = {
  language: "hi",
  firstMessage: toAgentTemplate(hi.voiceAgents.booking.firstMessage),
  safetyMessage: hi.screen.urgent,
  systemPrompt: bookingSystemPrompt({
    lang: PROMPT_LANGUAGES.hi,
    safetyMessage: hi.screen.urgent,
    lexicon: hi.voiceAgents.lexicon,
    confirmLabel: hi.voiceBooking.confirm,
    demoNotice: hi.voiceAgents.booking.demo.demoNotice,
  }),
};
