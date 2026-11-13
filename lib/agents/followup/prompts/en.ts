// Ticket 049 FR-2: the follow-up agent in English (the agent's base language; dashboard prompt unchanged).
import en from "@/messages/en.json";
import { toAgentTemplate } from "../../languages";
import { PROMPT_LANGUAGES } from "../../prompt-languages";
import type { AgentPrompt } from "../../prompts";
import { followupSystemPrompt } from "./template";

export const EN: AgentPrompt = {
  language: "en",
  firstMessage: toAgentTemplate(en.voiceAgents.followup.firstMessage),
  safetyMessage: en.screen.urgent,
  systemPrompt: followupSystemPrompt({
    lang: PROMPT_LANGUAGES.en,
    safetyMessage: en.screen.urgent,
    toolFailed: en.voiceAgents.followup.answers.toolFailed,
  }),
};
