// Ticket 034: voice booking agent. Pure constants and helpers, safe in the browser (the widget) and on the server.

export const BOOKING_AGENT_NAME = "DoctorNearMe Booking Assistant";

/** FR-3: a booking session accepts tool calls for 30 minutes. */
export const AGENT_SESSION_TTL_MS = 30 * 60_000;
/** FR-3: tool calls per session; the 21st gets 429. */
export const MAX_TOOL_CALLS = 20;
/** FR-2: new booking sessions per IP per hour. */
export const SESSIONS_PER_HOUR = 5;
/** FR-1: the agent's maximum conversation length (also enforced by the widget). */
export const VOICE_MAX_MINUTES = 6;
/** FR-3 result limits. */
export const MAX_PROVIDERS = 5;
export const MAX_SLOTS = 6;
/** get_slots looks this many days ahead of `date_from`. */
export const SLOT_SEARCH_DAYS = 7;

export const AGENT_TOOLS = ["search_providers", "get_slots", "hold_slot"] as const;
export type AgentTool = (typeof AGENT_TOOLS)[number];

export function isAgentTool(value: unknown): value is AgentTool {
  return typeof value === "string" && (AGENT_TOOLS as readonly string[]).includes(value);
}

export const PARTS_OF_DAY = ["morning", "afternoon", "evening"] as const;
export type PartOfDay = (typeof PARTS_OF_DAY)[number];

/** Local time (minutes after midnight in the service's time zone) -> part of day: before 12:00, 12:00-17:00, after. */
export function partOfDayOf(minutes: number): PartOfDay {
  if (minutes < 12 * 60) return "morning";
  if (minutes < 17 * 60) return "afternoon";
  return "evening";
}

/** FR-4: where `Sign in and confirm` goes; the 030 page attaches the hold through the browser's booking cookie. */
export function confirmUrl(profileId: string, appointmentId: string): string {
  return `/book/${profileId}?appointment=${appointmentId}`;
}

/** Header carrying the shared tool secret (configured on each server tool in the ElevenLabs dashboard). */
export const AGENT_SECRET_HEADER = "x-agent-secret";
