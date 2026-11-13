// Ticket 049 FR-2: the generic pre-consult intake agent in Telugu (language preset `te`). Native-speaker review: messages/REVIEW.md
// (`voiceAgents.genericIntake.*`) and the language review checklist in docs/elevenlabs-generic-intake-agent.md.
import te from "@/messages/te.json";
import { toAgentTemplate } from "../../languages";
import { PROMPT_LANGUAGES } from "../../prompt-languages";
import type { AgentPrompt } from "../../prompts";
import { genericIntakeSystemPrompt } from "./template";

export const TE: AgentPrompt = {
  language: "te",
  firstMessage: toAgentTemplate(te.voiceAgents.genericIntake.firstMessage),
  safetyMessage: te.voiceAgents.genericIntake.safetyMessage,
  systemPrompt: genericIntakeSystemPrompt({ lang: PROMPT_LANGUAGES.te, safetyMessage: te.voiceAgents.genericIntake.safetyMessage }),
};
