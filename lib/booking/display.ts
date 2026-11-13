// Display helpers shared by server pages and client components (pure). NFR-2: times in the viewer's time zone, plus
// the clinic's local time when an in-clinic appointment's zone differs at that instant.
import { HTML_LANG, type Locale } from "@/lib/i18n/config";
import { formatTime } from "@/lib/i18n/format";
import { utcToWall, zoneOffsetMinutes } from "./time";

export function clinicTimeIfDifferent(start: string, locale: Locale, viewerTz: string, clinicTz: string | null | undefined): string | null {
  if (!clinicTz || clinicTz === viewerTz) return null;
  const t = Date.parse(start);
  try {
    if (zoneOffsetMinutes(t, clinicTz) === zoneOffsetMinutes(t, viewerTz)) return null;
    return formatTime(start, locale, clinicTz);
  } catch {
    return null;
  }
}

/** `4:00 pm IST`, or `{viewer} your time · {clinic} at the clinic` via the translated templates. */
export function slotTimeLabel(
  start: string,
  locale: Locale,
  viewerTz: string,
  clinicTz: string | null | undefined,
  t: (key: "yourTime" | "clinicTime", vars: { time: string }) => string,
): string {
  const viewer = formatTime(start, locale, viewerTz);
  const clinic = clinicTimeIfDifferent(start, locale, viewerTz, clinicTz);
  return clinic ? `${t("yourTime", { time: viewer })} · ${t("clinicTime", { time: clinic })}` : viewer;
}

export function viewerDate(start: string, viewerTz: string): string {
  return utcToWall(Date.parse(start), viewerTz).date;
}

/** `Mon, 16 Nov` for a date strip button (date = YYYY-MM-DD in the viewer's zone). */
export function dayLabel(date: string, locale: Locale): { weekday: string; day: string } {
  const instant = new Date(`${date}T12:00:00Z`);
  const weekday = new Intl.DateTimeFormat(HTML_LANG[locale], { weekday: "short", timeZone: "UTC", numberingSystem: "latn" }).format(instant);
  const day = new Intl.DateTimeFormat(HTML_LANG[locale], { day: "numeric", month: "short", timeZone: "UTC", numberingSystem: "latn" }).format(instant);
  return { weekday, day };
}

export function feeLabel(feeInr: number, paymentMode: "online" | "at_clinic" | "free", inr: (paise: number) => string): string | null {
  return paymentMode === "free" || feeInr === 0 ? null : inr(feeInr * 100);
}

/** FR-7 list split: upcoming = confirmed / pending payment that has not ended; everything else is past. */
export function splitAppointments<T extends { status: string; starts_at: string; ends_at: string }>(all: T[], now = Date.now()): { upcoming: T[]; past: T[] } {
  const upcoming = all
    .filter((a) => (a.status === "confirmed" || a.status === "pending_payment") && Date.parse(a.ends_at) > now)
    .sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at));
  return { upcoming, past: all.filter((a) => !upcoming.includes(a)) };
}

/** A guardian may cancel / move a confirmed appointment up to `windowMinutes` before its start (SQL enforces it too). */
export function guardianCanChange(a: { status: string; starts_at: string }, windowMinutes: number, now = Date.now()): boolean {
  return a.status === "confirmed" && Date.parse(a.starts_at) - now > windowMinutes * 60_000;
}

export function hasStarted(startsAt: string, now = Date.now()): boolean {
  return Date.parse(startsAt) <= now;
}
