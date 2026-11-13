// Ticket 049 FR-3 / FR-6: the spoken-word lexicon of the voice agents. Answers spoken in Telugu or Hindi map to the
// same language-neutral codes as English (never/sometimes/often/always/yes/no, red-flag codes, provider types, modes,
// parts of the day). The words live in messages/{en,hi,te}.json (`voiceAgents.lexicon`, comma-separated synonyms, so
// native speakers review them in messages/REVIEW.md); the same words are written into the hi/te agent prompts. The
// DEMO_MODE scripts use these matchers in place of the agent's language model, so the te/hi scripts must produce the
// same tool calls as English (tests/agents-*-locale.test.ts). Pure, safe in the browser.
import { classifyRedFlagText } from "@/lib/clinical/red-flags";
import { RED_FLAG_CODES, type RedFlagCode } from "@/lib/clinical/checkin";
import type en from "@/messages/en.json";

export type Lexicon = (typeof en)["voiceAgents"]["lexicon"];

/** Canonical (English) spelling of the localities in the lexicon: what `search_providers.locality_text` receives. */
export const LOCALITY_NAMES: Record<keyof Lexicon["localities"], string> = {
  banjaraHills: "Banjara Hills",
  kukatpally: "Kukatpally",
  gachibowli: "Gachibowli",
  madhapur: "Madhapur",
};

/** Comma-separated synonyms -> list. */
export function synonyms(value: string): string[] {
  return value
    .split(",")
    .map((s) => normalizeUtterance(s))
    .filter(Boolean);
}

/** Lower case, no zero-width joiners, punctuation as spaces, single spaces. Keeps Devanagari/Telugu signs. */
export function normalizeUtterance(text: string): string {
  return text
    .normalize("NFC")
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .toLowerCase()
    .replace(/[.,!?;:"“”'‘’()।॥]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const ASCII = /^[\x00-\x7f]+$/;

function contains(text: string, phrase: string): boolean {
  if (!ASCII.test(phrase)) return text.includes(phrase);
  // Latin words match whole words only ("no" is not inside "not"); Indic phrases match as substrings (suffixes).
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`).test(text);
}

/** The code whose longest synonym occurs in the text (longest first: "कभी नहीं" before "नहीं"). */
export function matchCode<C extends string>(text: string, options: Partial<Record<C, string>>): C | null {
  const t = normalizeUtterance(text);
  const pairs = (Object.entries(options) as [C, string][])
    .flatMap(([code, value]) => synonyms(value ?? "").map((phrase) => ({ code, phrase })))
    .sort((a, b) => b.phrase.length - a.phrase.length);
  return pairs.find((p) => contains(t, p.phrase))?.code ?? null;
}

export type AnswerCode = keyof Lexicon["answers"];

/** A spoken answer -> the code allowed by the question's scale (e.g. never/sometimes/often/always), or null. */
export function interpretAnswer(lexicon: Lexicon, text: string, scale: readonly string[]): AnswerCode | null {
  const options: Partial<Record<AnswerCode, string>> = {};
  for (const code of scale) if (code in lexicon.answers) options[code as AnswerCode] = lexicon.answers[code as AnswerCode];
  return matchCode(text, options);
}

/** A red flag described in the parent's own words (any language), or null. English also uses the shared classifier. */
export function detectRedFlag(lexicon: Lexicon, text: string): RedFlagCode | null {
  const hit = matchCode<RedFlagCode>(text, lexicon.redFlags as Record<RedFlagCode, string>);
  if (hit) return hit;
  const classified = classifyRedFlagText(text);
  if (!classified) return null;
  return (RED_FLAG_CODES as readonly string[]).includes(classified) ? (classified as RedFlagCode) : "safety_concern";
}

export type BookingRequest = {
  locality_text?: string;
  type?: keyof Lexicon["types"];
  mode?: keyof Lexicon["modes"];
  part_of_day?: keyof Lexicon["partsOfDay"];
};

/** "A speech therapist near Banjara Hills, at the clinic" (any language) -> the search_providers / get_slots codes. */
export function interpretBookingRequest(lexicon: Lexicon, text: string): BookingRequest {
  const localityOptions = Object.fromEntries(
    (Object.keys(LOCALITY_NAMES) as (keyof Lexicon["localities"])[]).map((key) => [key, `${lexicon.localities[key]}, ${LOCALITY_NAMES[key]}`]),
  ) as Record<keyof Lexicon["localities"], string>;
  const locality = matchCode(text, localityOptions);
  const pin = /\b5\d{5}\b/.exec(text)?.[0];
  const out: BookingRequest = {};
  if (locality) out.locality_text = LOCALITY_NAMES[locality];
  else if (pin) out.locality_text = pin;
  const type = matchCode(text, lexicon.types);
  if (type) out.type = type;
  const mode = matchCode(text, lexicon.modes);
  if (mode) out.mode = mode;
  const part = matchCode(text, lexicon.partsOfDay);
  if (part) out.part_of_day = part;
  return out;
}

/** "The first one" -> 0, "the second" -> 1, "the third" -> 2, else null. */
export function interpretChoice(lexicon: Lexicon, text: string): 0 | 1 | 2 | null {
  const choice = matchCode(text, lexicon.choices);
  return choice === "first" ? 0 : choice === "second" ? 1 : choice === "third" ? 2 : null;
}

export function isYes(lexicon: Lexicon, text: string): boolean {
  return matchCode(text, { yes: lexicon.answers.yes, no: lexicon.answers.no }) === "yes";
}
