// Server-side catalogue loading. Never import this from a client component: it bundles every locale.
import en from "@/messages/en.json";
import hi from "@/messages/hi.json";
import te from "@/messages/te.json";
import { DEFAULT_LOCALE, type Locale } from "./config";
import { warnOnce, type MessageTree } from "./translate";

if (typeof window !== "undefined") {
  throw new Error("lib/i18n/messages.ts is server-only");
}

export const CATALOGUES: Record<Locale, MessageTree> = { en, hi, te };

/** `target` with every key missing from it filled from `fallback` (warns once per filled key). */
export function withFallback(target: MessageTree, fallback: MessageTree, locale: string, prefix = ""): MessageTree {
  const out: MessageTree = {};
  for (const [key, value] of Object.entries(fallback)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const own = target[key];
    if (typeof value === "string") {
      if (typeof own === "string") out[key] = own;
      else {
        warnOnce(`"${path}" missing in ${locale}, using en`);
        out[key] = value;
      }
    } else {
      out[key] = withFallback(typeof own === "object" ? own : {}, value, locale, path);
    }
  }
  return out;
}

const merged = new Map<Locale, MessageTree>();

/** The active locale's catalogue, with any missing key filled from en. Only this goes to the browser. */
export function getMessages(locale: Locale): MessageTree {
  if (locale === DEFAULT_LOCALE) return CATALOGUES.en;
  let messages = merged.get(locale);
  if (!messages) {
    messages = withFallback(CATALOGUES[locale], CATALOGUES.en, locale);
    merged.set(locale, messages);
  }
  return messages;
}
