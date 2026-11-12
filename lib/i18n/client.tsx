"use client";

// Client-side i18n (ticket 018). The root layout renders <I18nProvider> with only the active locale's
// messages; client components call useT() / useFormatter() / useLocale().
import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { Locale } from "./config";
import { createFormatter, type Formatter } from "./format";
import type { Namespace, TFunction } from "./keys";
import { createTranslator, type MessageTree } from "./translate";

type I18nValue = { locale: Locale; timeZone: string; messages: MessageTree };

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({
  locale,
  timeZone,
  messages,
  children,
}: I18nValue & { children?: ReactNode }) {
  const value = useMemo(() => ({ locale, timeZone, messages }), [locale, timeZone, messages]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

function useI18nContext(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error("i18n hooks must be used inside <I18nProvider> (rendered by app/layout.tsx)");
  return value;
}

/** `t(key, values?)` for the active locale. With a namespace, keys are relative: `useT("login")` -> `t("title")`. */
export function useT<N extends Namespace | undefined = undefined>(namespace?: N): TFunction<N> {
  const { locale, messages } = useI18nContext();
  return useMemo(() => createTranslator(locale, messages, namespace), [locale, messages, namespace]);
}

export function useLocale(): Locale {
  return useI18nContext().locale;
}

export function useTimeZone(): string {
  return useI18nContext().timeZone;
}

/** Date, time, number and INR formatters bound to the active locale and the viewer's time zone. */
export function useFormatter(): Formatter {
  const { locale, timeZone } = useI18nContext();
  return useMemo(() => createFormatter(locale, timeZone), [locale, timeZone]);
}
