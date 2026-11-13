// Ticket 049 FR-2: the follow-up agent in Hindi (language preset `hi`). Native-speaker review: messages/REVIEW.md
// (`voiceAgents.followup.*`, `screen.urgent`) and the language review checklist in docs/elevenlabs-followup-agent.md.
import hi from "@/messages/hi.json";
import { toAgentTemplate } from "../../languages";
import { PROMPT_LANGUAGES } from "../../prompt-languages";
import type { AgentPrompt } from "../../prompts";
import { followupSystemPrompt } from "./template";

export const HI: AgentPrompt = {
  language: "hi",
  firstMessage: toAgentTemplate(hi.voiceAgents.followup.firstMessage),
  safetyMessage: hi.screen.urgent,
  systemPrompt: followupSystemPrompt({
    lang: PROMPT_LANGUAGES.hi,
    safetyMessage: hi.screen.urgent,
    toolFailed: hi.voiceAgents.followup.answers.toolFailed,
  }),
};
