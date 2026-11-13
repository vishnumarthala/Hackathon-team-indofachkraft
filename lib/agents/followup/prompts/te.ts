// Ticket 049 FR-2: the follow-up agent in Telugu (language preset `te`). Native-speaker review: messages/REVIEW.md
// (`voiceAgents.followup.*`, `screen.urgent`) and the language review checklist in docs/elevenlabs-followup-agent.md.
import te from "@/messages/te.json";
import { toAgentTemplate } from "../../languages";
import { PROMPT_LANGUAGES } from "../../prompt-languages";
import type { AgentPrompt } from "../../prompts";
import { followupSystemPrompt } from "./template";

export const TE: AgentPrompt = {
  language: "te",
  firstMessage: toAgentTemplate(te.voiceAgents.followup.firstMessage),
  safetyMessage: te.screen.urgent,
  systemPrompt: followupSystemPrompt({
    lang: PROMPT_LANGUAGES.te,
    safetyMessage: te.screen.urgent,
    toolFailed: te.voiceAgents.followup.answers.toolFailed,
  }),
};
