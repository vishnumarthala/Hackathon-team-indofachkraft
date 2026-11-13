// Ticket 049 FR-2: every language-aware voice agent's prompts (server only; scripts/elevenlabs-language-presets.ts and
// the locale tests read them).
import type { Locale } from "@/lib/i18n/config";
import { BOOKING_PROMPTS } from "./booking/prompts";
import { FOLLOWUP_PROMPTS } from "./followup/prompts";
import { GENERIC_INTAKE_PROMPTS } from "./generic-intake/prompts";
import type { LanguageAgent } from "./languages";
import type { AgentPrompt } from "./prompts";
import { SCREEN_PROMPTS } from "./screen/prompts";

export const AGENT_PROMPTS: Record<LanguageAgent, Record<Locale, AgentPrompt>> = {
  screen: SCREEN_PROMPTS,
  booking: BOOKING_PROMPTS,
  generic_intake: GENERIC_INTAKE_PROMPTS,
  followup: FOLLOWUP_PROMPTS,
};
