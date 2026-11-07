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

const berlinParts = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Berlin",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function parts(value: string | Date): Record<string, string> {
  return Object.fromEntries(berlinParts.formatToParts(new Date(value)).map((p) => [p.type, p.value]));
}

export function formatDateTime(value: string | Date): string {
  const p = parts(value);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

export function formatDate(value: string | Date): string {
  const p = parts(value);
  return `${p.year}-${p.month}-${p.day}`;
}
