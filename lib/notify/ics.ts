// RFC 5545 calendar invite for email attachments (FR-6). UID is stable per aggregate (e.g. one appointment) and
// SEQUENCE increments with every later event about it, so calendar apps update the same entry.
import type { IcsInvite } from "./types";

function stamp(value: string | Date): string {
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) throw new Error("Invalid calendar date");
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function escapeText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/** Folds content lines longer than 75 octets (continuation lines start with a space). */
function fold(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let current = "";
  let size = 0;
  for (const ch of line) {
    const len = Buffer.byteLength(ch, "utf8");
    const limit = parts.length === 0 ? 75 : 74;
    if (size + len > limit) {
      parts.push(current);
      current = "";
      size = 0;
    }
    current += ch;
    size += len;
  }
  parts.push(current);
  return parts.join("\r\n ");
}

export function icsUid(aggregateType: string, aggregateId: string): string {
  return `${aggregateType}-${aggregateId}@doctornearme`;
}

export type IcsOptions = {
  uid: string;
  sequence: number;
  now?: Date;
  organizer?: string | null;
  attendee?: string | null;
};

export function buildIcs(invite: IcsInvite, opts: IcsOptions): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//DoctorNearMe//Notifications//EN",
    "CALSCALE:GREGORIAN",
    `METHOD:${invite.method}`,
    "BEGIN:VEVENT",
    `UID:${opts.uid}`,
    `SEQUENCE:${Math.max(0, Math.trunc(opts.sequence))}`,
    `DTSTAMP:${stamp(opts.now ?? new Date())}`,
    `DTSTART:${stamp(invite.start)}`,
    `DTEND:${stamp(invite.end)}`,
    `SUMMARY:${escapeText(invite.summary)}`,
    ...(invite.description ? [`DESCRIPTION:${escapeText(invite.description)}`] : []),
    ...(invite.location ? [`LOCATION:${escapeText(invite.location)}`] : []),
    ...(invite.url ? [`URL:${invite.url}`] : []),
    ...(opts.organizer ? [`ORGANIZER:mailto:${opts.organizer}`] : []),
    ...(opts.attendee ? [`ATTENDEE;ROLE=REQ-PARTICIPANT;RSVP=FALSE:mailto:${opts.attendee}`] : []),
    `STATUS:${invite.method === "CANCEL" ? "CANCELLED" : "CONFIRMED"}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return `${lines.map(fold).join("\r\n")}\r\n`;
}
