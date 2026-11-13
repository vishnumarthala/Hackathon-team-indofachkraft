// 043 weekly-series templates. Content (FR-8): the provider, the weekdays and time in the clinic's time zone (with its
// abbreviation), mode/place and the dates of a change - never the child's name or anything clinical. One message per
// series change; per-session reminders reuse 030's `appointment_reminder_24h`. WhatsApp: one body parameter, the app
// link (docs/notifications.md).
import type { Locale } from "@/lib/i18n/config";
import { formatDate, formatDateTime, formatTime } from "@/lib/i18n/format";
import { occurrenceInstant, weekdayList } from "@/lib/booking/series-display";
import type { Template, TemplateContext } from "../types";
import { defineTemplate, roleLink, type TemplateStrings } from "./shared";

export type SeriesPayload = {
  series_id: string;
  provider_name: string;
  mode: "in_clinic" | "video";
  time_zone: string;
  weekdays: number[];
  start_time: string;
  starts_on: string;
  ends_on: string | null;
  location?: string | null;
  change?: "time_changed" | "paused" | "ended" | "skipped" | "moved";
  date?: string;
  until?: string;
  new_start?: string;
};

export type SeriesValues = {
  provider: string;
  days: string;
  time: string;
  where: string;
  starts: string;
  date: string;
  until: string;
  newTime: string;
  role: "guardian" | "provider";
};

const WHERE: Record<Locale, { video: string; clinic: (location: string) => string; clinicUnknown: string }> = {
  en: { video: "Video sessions", clinic: (l) => `In clinic: ${l}`, clinicUnknown: "In clinic" },
  hi: { video: "वीडियो सेशन", clinic: (l) => `क्लिनिक में: ${l}`, clinicUnknown: "क्लिनिक में" },
  te: { video: "వీడియో సెషన్లు", clinic: (l) => `క్లినిక్‌లో: ${l}`, clinicUnknown: "క్లినిక్‌లో" },
};

function safeZone(tz: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "Asia/Kolkata";
  }
}

const day = (date: string | undefined, locale: Locale) => (date ? formatDate(`${date}T12:00:00Z`, locale, "long", "UTC") : "");

export function seriesValues(ctx: TemplateContext<SeriesPayload>): SeriesValues {
  const p = ctx.payload;
  const tz = safeZone(p.time_zone);
  const w = WHERE[ctx.locale] ?? WHERE.en;
  return {
    provider: p.provider_name,
    days: weekdayList(p.weekdays, ctx.locale),
    time: formatTime(occurrenceInstant(p.date ?? p.starts_on, p.start_time, tz), ctx.locale, tz),
    where: p.mode === "video" ? w.video : p.location ? w.clinic(p.location) : w.clinicUnknown,
    starts: day(p.starts_on, ctx.locale),
    date: day(p.date, ctx.locale),
    until: day(p.until, ctx.locale),
    newTime: p.new_start ? formatDateTime(p.new_start, ctx.locale, tz) : "",
    role: ctx.role === "guardian" ? "guardian" : "provider",
  };
}

export function seriesTemplate(
  name: string,
  strings: Record<Locale, (v: SeriesValues, change: SeriesPayload["change"]) => TemplateStrings>,
): Template<SeriesPayload> {
  return {
    name,
    render(ctx) {
      const v = seriesValues(ctx);
      return defineTemplate<SeriesPayload>({
        name,
        strings: {
          en: strings.en(v, ctx.payload.change),
          hi: strings.hi(v, ctx.payload.change),
          te: strings.te(v, ctx.payload.change),
        },
        link: (c) => roleLink(c, "/family/appointments", "/dashboard/schedule"),
      }).render(ctx);
    },
  };
}
