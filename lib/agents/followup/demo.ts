// Ticket 049 (server only): the DEMO_MODE follow-up voice panel's lexicon for a call language, from the catalogue.
import type { Locale } from "@/lib/i18n/config";
import { agentTexts } from "../call-language";
import type { FollowupDemoScript } from "./demo-script";

export function followupDemoScript(language: Locale): FollowupDemoScript {
  const { followup, redFlags, answers } = agentTexts(language).lexicon;
  return { language, lexicon: { followup, redFlags, answers } };
}
