// Ticket 049 (server only): which languages each voice agent has (FR-4), the call language of a voice start (FR-1) and
// the agents' fixed texts in a language (FR-2: first messages and safety messages come from messages/{en,hi,te}.json,
// the same catalogue the pages use, so they are identical by construction and reviewed in messages/REVIEW.md).
import { isDemoMode } from "@/lib/demo";
import { env } from "@/lib/env";
import { fail } from "@/lib/http";
import { LOCALES, isLocale, type Locale } from "@/lib/i18n/config";
import { getMessages } from "@/lib/i18n/messages";
import { getLocale } from "@/lib/i18n/server";
import type en from "@/messages/en.json";
import { LANGUAGE_UNAVAILABLE, parseVoiceLanguages, type LanguageAgent } from "./languages";

if (typeof window !== "undefined") {
  throw new Error("lib/agents/call-language.ts is server-only");
}

/**
 * FR-4: the languages enabled on an agent (`ELEVENLABS_<AGENT>_LANGUAGES`, e.g. `en,hi,te`). Unset: English only for
 * real calls (the human enables Hindi and Telugu in the dashboard first, docs/elevenlabs-*-agent.md, then sets the
 * variable); all three in DEMO_MODE, which never contacts ElevenLabs.
 */
export function enabledVoiceLanguages(agent: LanguageAgent): Locale[] {
  const raw = {
    screen: env.ELEVENLABS_SCREEN_LANGUAGES,
    booking: env.ELEVENLABS_BOOKING_LANGUAGES,
    generic_intake: env.ELEVENLABS_GENERIC_INTAKE_LANGUAGES,
    followup: env.ELEVENLABS_FOLLOWUP_LANGUAGES,
  }[agent];
  return parseVoiceLanguages(raw, isDemoMode() ? LOCALES : ["en"]);
}

export type CallLanguage = { ok: true; language: Locale } | { ok: false; response: Response };

/**
 * FR-1 / FR-4: the call language of a voice start: the language the page asked for (the viewer's UI locale, or `en`
 * after the parent chose "Voice in English"), else the viewer's locale. A language the agent does not have -> 409
 * `language_unavailable` with the enabled list; never a silent English call.
 */
export async function resolveCallLanguage(agent: LanguageAgent, requested: unknown): Promise<CallLanguage> {
  const enabled = enabledVoiceLanguages(agent);
  let language: Locale;
  if (isLocale(requested)) language = requested;
  // Outside a request (scripts, tests) there is no viewer: English, the agent's base language.
  else language = await getLocale().catch(() => "en" as const);
  if (!enabled.includes(language)) {
    return { ok: false, response: fail(409, LANGUAGE_UNAVAILABLE, { language, enabled }) };
  }
  return { ok: true, language };
}

export type AgentTexts = (typeof en)["voiceAgents"];

/** The `voiceAgents` catalogue section in a language (first messages, demo lines, lexicon). */
export function agentTexts(language: Locale): AgentTexts {
  return getMessages(language).voiceAgents as unknown as AgentTexts;
}

/** The 033 safety message (108/112) in a language: `screen.urgent`, word for word what the page shows. */
export function urgentMessage(language: Locale): string {
  return (getMessages(language).screen as unknown as { urgent: string }).urgent;
}
