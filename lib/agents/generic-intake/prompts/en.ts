// Ticket 049 FR-2: the generic pre-consult intake agent in English (the agent's base language; dashboard prompt unchanged).
import en from "@/messages/en.json";
import { toAgentTemplate } from "../../languages";
import { PROMPT_LANGUAGES } from "../../prompt-languages";
import type { AgentPrompt } from "../../prompts";
import { genericIntakeSystemPrompt } from "./template";

export const EN: AgentPrompt = {
  language: "en",
  firstMessage: toAgentTemplate(en.voiceAgents.genericIntake.firstMessage),
  safetyMessage: en.voiceAgents.genericIntake.safetyMessage,
  systemPrompt: genericIntakeSystemPrompt({ lang: PROMPT_LANGUAGES.en, safetyMessage: en.voiceAgents.genericIntake.safetyMessage }),
};
