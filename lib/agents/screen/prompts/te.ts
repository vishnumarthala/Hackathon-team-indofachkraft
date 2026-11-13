// Ticket 049 FR-2: the check-in agent in Telugu (language preset `te`). Native-speaker review: messages/REVIEW.md
// (`voiceAgents.*`, `screen.urgent`) and the language review checklist in docs/elevenlabs-screen-agent.md.
import te from "@/messages/te.json";
import { toAgentTemplate } from "../../languages";
import { PROMPT_LANGUAGES } from "../../prompt-languages";
import type { AgentPrompt } from "../../prompts";
import { screenSystemPrompt } from "./template";

export const TE: AgentPrompt = {
  language: "te",
  firstMessage: toAgentTemplate(te.voiceAgents.screen.firstMessage),
  safetyMessage: te.screen.urgent,
  systemPrompt: screenSystemPrompt({ lang: PROMPT_LANGUAGES.te, safetyMessage: te.screen.urgent, answers: te.voiceAgents.lexicon.answers }),
};
