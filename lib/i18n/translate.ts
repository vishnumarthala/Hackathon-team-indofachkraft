// The translator used by getT() (server) and useT() (client). Works on one already-merged catalogue,
// so the browser never needs a second locale's messages.
import { HTML_LANG, type Locale } from "./config";
import type { KeyIn, Namespace, TFunction, TranslationValues } from "./keys";

export type MessageTree = { [key: string]: string | MessageTree };

const warned = new Set<string>();

/** Warns once per message outside production (missing keys, missing variables, en fallbacks). */
export function warnOnce(message: string): void {
  if (process.env.NODE_ENV === "production" || warned.has(message)) return;
  warned.add(message);
  console.warn(`[i18n] ${message}`);
}

export function lookup(tree: MessageTree, key: string): string | undefined {
  let node: string | MessageTree | undefined = tree;
  for (const part of key.split(".")) {
    if (node === undefined || typeof node === "string") return undefined;
    node = node[part];
  }
  return typeof node === "string" ? node : undefined;
}

const numberFormats = new Map<Locale, Intl.NumberFormat>();
function formatCount(value: number, locale: Locale): string {
  let format = numberFormats.get(locale);
  if (!format) {
    format = new Intl.NumberFormat(HTML_LANG[locale], { numberingSystem: "latn" });
    numberFormats.set(locale, format);
  }
  return format.format(value);
}

/** Replaces `{name}` placeholders. A missing variable stays literal (and warns outside production). */
export function interpolate(template: string, values: TranslationValues | undefined, locale: Locale, key: string): string {
  return template.replace(/\{(\w+)\}/g, (placeholder, name: string) => {
    const value = values?.[name];
    if (value === undefined) {
      warnOnce(`Missing variable {${name}} for "${key}" (${locale})`);
      return placeholder;
    }
    return typeof value === "number" ? formatCount(value, locale) : value;
  });
}

const pluralRules = new Map<Locale, Intl.PluralRules>();
function pluralCategory(count: number, locale: Locale): Intl.LDMLPluralRule {
  let rules = pluralRules.get(locale);
  if (!rules) {
    rules = new Intl.PluralRules(HTML_LANG[locale]);
    pluralRules.set(locale, rules);
  }
  return rules.select(count);
}

export function createTranslator<N extends Namespace | undefined = undefined>(
  locale: Locale,
  messages: MessageTree,
  namespace?: N,
): TFunction<N> {
  return (key, values) => {
    const fullKey = namespace ? `${namespace}.${key}` : String(key);
    let template: string | undefined;
    const count = values?.count;
    if (typeof count === "number") {
      template = lookup(messages, `${fullKey}_${pluralCategory(count, locale)}`) ?? lookup(messages, `${fullKey}_other`);
    }
    template ??= lookup(messages, fullKey);
    if (template === undefined) {
      warnOnce(`Missing message "${fullKey}" (${locale})`);
      return fullKey;
    }
    return interpolate(template, values, locale, fullKey);
  };
}

export type { KeyIn, Namespace, TFunction, TranslationValues };
