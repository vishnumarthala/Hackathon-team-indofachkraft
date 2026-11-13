// Ticket 049 FR-2: the check-in agent in English (the agent's base language; dashboard prompt unchanged).
import en from "@/messages/en.json";
import { toAgentTemplate } from "../../languages";
import { PROMPT_LANGUAGES } from "../../prompt-languages";
import type { AgentPrompt } from "../../prompts";
import { screenSystemPrompt } from "./template";

export const EN: AgentPrompt = {
  language: "en",
  firstMessage: toAgentTemplate(en.voiceAgents.screen.firstMessage),
  safetyMessage: en.screen.urgent,
  systemPrompt: screenSystemPrompt({ lang: PROMPT_LANGUAGES.en, safetyMessage: en.screen.urgent, answers: en.voiceAgents.lexicon.answers }),
};
