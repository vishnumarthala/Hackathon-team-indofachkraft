// Locale-aware formatting in the viewer's time zone (ticket 018, FR-5/FR-5a). Pure: safe on server and client.
// Storage stays UTC (timestamptz); only display converts. Digits are always Latin.
import { HTML_LANG, type Locale } from "./config";

export type DateInput = string | number | Date;
export type DateStyle = "short" | "long";

const cache = new Map<string, Intl.DateTimeFormat | Intl.NumberFormat>();

function dateFormat(locale: Locale, timeZone: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `d|${locale}|${timeZone}|${JSON.stringify(options)}`;
  let format = cache.get(key) as Intl.DateTimeFormat | undefined;
  if (!format) {
    format = new Intl.DateTimeFormat(HTML_LANG[locale], { ...options, timeZone, numberingSystem: "latn" });
    cache.set(key, format);
  }
  return format;
}

function numberFormat(locale: Locale, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `n|${locale}|${JSON.stringify(options)}`;
  let format = cache.get(key) as Intl.NumberFormat | undefined;
  if (!format) {
    format = new Intl.NumberFormat(HTML_LANG[locale], { ...options, numberingSystem: "latn" });
    cache.set(key, format);
  }
  return format;
}

const DATE_OPTIONS: Record<DateStyle, Intl.DateTimeFormatOptions> = {
  short: { day: "numeric", month: "short", year: "numeric" },
  long: { day: "numeric", month: "long", year: "numeric" },
};

const TIME_OPTIONS: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit", timeZoneName: "short" };

/** `13 Nov 2026` (short) or `13 November 2026` (long), in `timeZone`. Dates carry no zone suffix. */
export function formatDate(value: DateInput, locale: Locale, style: DateStyle, timeZone: string): string {
  return dateFormat(locale, timeZone, DATE_OPTIONS[style]).format(new Date(value));
}

/** `13 Nov 2026, 1:30 am IST`: a time always shows its zone abbreviation so it is never ambiguous. */
export function formatDateTime(value: DateInput, locale: Locale, timeZone: string): string {
  return dateFormat(locale, timeZone, { ...DATE_OPTIONS.short, ...TIME_OPTIONS }).format(new Date(value));
}

/** `1:30 am IST`. */
export function formatTime(value: DateInput, locale: Locale, timeZone: string): string {
  return dateFormat(locale, timeZone, TIME_OPTIONS).format(new Date(value));
}

/** Indian digit grouping: `12,34,567.5`. */
export function formatNumber(value: number, locale: Locale): string {
  return numberFormat(locale, {}).format(value);
}

/** Integer paise to rupees: `formatInr(15000000, "en")` = `₹1,50,000`; paise shown only when non-zero. */
export function formatInr(paise: number, locale: Locale): string {
  const fraction = Number.isInteger(paise / 100) ? 0 : 2;
  return numberFormat(locale, {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: fraction,
    maximumFractionDigits: fraction,
  }).format(paise / 100);
}

/** All formatters bound to one locale and time zone: `getFormatter()` (server) / `useFormatter()` (client). */
export type Formatter = {
  locale: Locale;
  timeZone: string;
  date: (value: DateInput, style?: DateStyle) => string;
  dateTime: (value: DateInput) => string;
  time: (value: DateInput) => string;
  number: (value: number) => string;
  inr: (paise: number) => string;
};

export function createFormatter(locale: Locale, timeZone: string): Formatter {
  return {
    locale,
    timeZone,
    date: (value, style = "short") => formatDate(value, locale, style, timeZone),
    dateTime: (value) => formatDateTime(value, locale, timeZone),
    time: (value) => formatTime(value, locale, timeZone),
    number: (value) => formatNumber(value, locale),
    inr: (paise) => formatInr(paise, locale),
  };
}
