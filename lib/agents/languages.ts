// Ticket 049: Telugu and Hindi for the screen, booking, generic intake and follow-up voice agents. Pure and safe in the
// browser. One ElevenLabs agent per purpose serves en/hi/te: the page asks for the viewer's UI locale, the server checks
// that the language is enabled on that agent (env `ELEVENLABS_<AGENT>_LANGUAGES`) and the browser starts the call with
// the language override (the per-language first message and prompt live in the agent's language presets, generated
// from lib/agents/<agent>/prompts). A language that is not enabled is never replaced by English silently: the page
// offers "Voice in English" or the tap/type path instead (FR-4).
import { LOCALES, isLocale, type Locale } from "@/lib/i18n/config";

export const LANGUAGE_AGENTS = ["screen", "booking", "generic_intake", "followup"] as const;
export type LanguageAgent = (typeof LANGUAGE_AGENTS)[number];

/** FR-4: the env var listing the languages enabled on each agent, e.g. `en,hi,te`. */
export const LANGUAGES_ENV: Record<LanguageAgent, string> = {
  screen: "ELEVENLABS_SCREEN_LANGUAGES",
  booking: "ELEVENLABS_BOOKING_LANGUAGES",
  generic_intake: "ELEVENLABS_GENERIC_INTAKE_LANGUAGES",
  followup: "ELEVENLABS_FOLLOWUP_LANGUAGES",
};

/** API error code (409) of a voice start in a language the agent does not have. */
export const LANGUAGE_UNAVAILABLE = "language_unavailable";

/** The agent's own (default) language: always enabled, it is the base configuration of every agent. */
export const BASE_LANGUAGE = "en" as const satisfies Locale;

/**
 * `en,hi,te` -> the enabled languages in LOCALES order, always including English. Unknown codes are ignored; unset or
 * empty -> `fallback`.
 */
export function parseVoiceLanguages(raw: string | undefined | null, fallback: readonly Locale[]): Locale[] {
  const listed = (raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(isLocale);
  const chosen = new Set<Locale>(listed.length ? listed : fallback);
  chosen.add(BASE_LANGUAGE);
  return LOCALES.filter((l) => chosen.has(l));
}

export type VoiceLanguagePlan =
  /** The agent speaks the viewer's language: start in it. */
  | { kind: "native"; language: Locale }
  /** FR-4: not enabled; the page offers "Voice in English" or the tap/type path in the viewer's language. */
  | { kind: "fallback"; language: typeof BASE_LANGUAGE; locale: Locale };

export function planVoiceLanguage(locale: Locale, enabled: readonly Locale[]): VoiceLanguagePlan {
  if (enabled.includes(locale)) return { kind: "native", language: locale };
  return { kind: "fallback", language: BASE_LANGUAGE, locale };
}

/**
 * The `overrides` part of `startSession`: only the language (the one override each agent allows, like the intake
 * agent), and only for Hindi or Telugu: an English call uses the agent's base configuration, so English keeps working
 * on an agent whose language override is not switched on yet.
 */
export function voiceOverrides(language: Locale): { overrides?: { agent: { language: Locale } } } {
  return language === BASE_LANGUAGE ? {} : { overrides: { agent: { language } } };
}

/** i18n template (`{age_band}`) -> ElevenLabs dynamic variable syntax (`{{age_band}}`). */
export function toAgentTemplate(text: string): string {
  return text.replace(/\{(\w+)\}/g, "{{$1}}");
}

/** Fills `{name}` (i18n) placeholders; unknown names stay as written. Used by the DEMO_MODE scripts. */
export function fillTemplate(text: string, values: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => (name in values ? String(values[name]) : whole));
}

/** `<span lang>` / `SpeechSynthesisUtterance.lang` for captions and read-aloud answers in the call language. */
export const SPEECH_LANG: Record<Locale, string> = { en: "en-IN", hi: "hi-IN", te: "te-IN" };

/** Reads the `language` a voice start response carries (defaults to English for older responses). */
export function responseLanguage(body: { language?: unknown } | null | undefined): Locale {
  return isLocale(body?.language) ? body.language : BASE_LANGUAGE;
}
