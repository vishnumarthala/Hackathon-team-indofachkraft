import { createElement, type ReactElement } from "react";
import { I18nProvider } from "@/lib/i18n/client";
import { DEFAULT_TIME_ZONE, type Locale } from "@/lib/i18n/config";
import { getMessages } from "@/lib/i18n/messages";

/** Wraps a client component in the provider the root layout renders (ticket 018). */
export function withI18n(element: ReactElement, locale: Locale = "en", timeZone = DEFAULT_TIME_ZONE): ReactElement {
  return createElement(I18nProvider, { locale, timeZone, messages: getMessages(locale) }, element);
}
