// Ticket 049 FR-2: the check-in agent in Hindi (language preset `hi`). Native-speaker review: messages/REVIEW.md
// (`voiceAgents.*`, `screen.urgent`) and the language review checklist in docs/elevenlabs-screen-agent.md.
import hi from "@/messages/hi.json";
import { toAgentTemplate } from "../../languages";
import { PROMPT_LANGUAGES } from "../../prompt-languages";
import type { AgentPrompt } from "../../prompts";
import { screenSystemPrompt } from "./template";

export const HI: AgentPrompt = {
  language: "hi",
  firstMessage: toAgentTemplate(hi.voiceAgents.screen.firstMessage),
  safetyMessage: hi.screen.urgent,
  systemPrompt: screenSystemPrompt({ lang: PROMPT_LANGUAGES.hi, safetyMessage: hi.screen.urgent, answers: hi.voiceAgents.lexicon.answers }),
};
