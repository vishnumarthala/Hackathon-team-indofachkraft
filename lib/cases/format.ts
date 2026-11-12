import { DEFAULT_TIME_ZONE } from "@/lib/i18n/config";

export type CaseStatus = "booked" | "intake_done" | "in_assessment" | "referred";

export const LANGUAGE_NAMES: Record<string, string> = { en: "English", hi: "Hindi", te: "Telugu" };

export const STATUS_LABELS: Record<CaseStatus, string> = {
  booked: "Booked",
  intake_done: "Intake done",
  in_assessment: "In assessment",
  referred: "Referred",
};

export const NEXT_STEPS: Record<CaseStatus, string> = {
  booked: "Send the parent an intake link from the Brief tab.",
  intake_done: "Review the brief, then upload session 1 from the Sessions tab.",
  in_assessment: "Confirm the ISAA items in the latest session.",
  referred: "Referral sent. The specialist can ask questions about the case.",
};

export function languageName(code: string): string {
  return LANGUAGE_NAMES[code] ?? code;
}

export function statusLabel(status: string): string {
  return STATUS_LABELS[status as CaseStatus] ?? status;
}

export function ageLabel(months: number | null | undefined): string {
  return months == null ? "-" : `${months} months`;
}

// Case dates in the viewer's time zone (ticket 018): pass getTimeZone() / useTimeZone(); the default is the
// product fallback zone. Storage stays UTC.
const partsFormats = new Map<string, Intl.DateTimeFormat>();

function parts(value: string | Date, timeZone: string): Record<string, string> {
  let format = partsFormats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-IN", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZoneName: "short",
      numberingSystem: "latn",
    });
    partsFormats.set(timeZone, format);
  }
  return Object.fromEntries(format.formatToParts(new Date(value)).map((p) => [p.type, p.value]));
}

/** `YYYY-MM-DD HH:mm IST`: times always carry the zone abbreviation. */
export function formatDateTime(value: string | Date, timeZone: string = DEFAULT_TIME_ZONE): string {
  const p = parts(value, timeZone);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ${p.timeZoneName}`;
}

/** `YYYY-MM-DD` in the given zone. */
export function formatDate(value: string | Date, timeZone: string = DEFAULT_TIME_ZONE): string {
  const p = parts(value, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}
