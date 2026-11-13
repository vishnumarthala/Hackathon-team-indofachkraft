// Ticket 049 FR-2: the generic pre-consult intake agent in Hindi (language preset `hi`). Native-speaker review: messages/REVIEW.md
// (`voiceAgents.genericIntake.*`) and the language review checklist in docs/elevenlabs-generic-intake-agent.md.
import hi from "@/messages/hi.json";
import { toAgentTemplate } from "../../languages";
import { PROMPT_LANGUAGES } from "../../prompt-languages";
import type { AgentPrompt } from "../../prompts";
import { genericIntakeSystemPrompt } from "./template";

export const HI: AgentPrompt = {
  language: "hi",
  firstMessage: toAgentTemplate(hi.voiceAgents.genericIntake.firstMessage),
  safetyMessage: hi.voiceAgents.genericIntake.safetyMessage,
  systemPrompt: genericIntakeSystemPrompt({ lang: PROMPT_LANGUAGES.hi, safetyMessage: hi.voiceAgents.genericIntake.safetyMessage }),
};
