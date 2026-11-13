// Anonymous booking session (FR-3 hold ownership before sign-in). The browser keeps a random id in an httpOnly
// cookie; the database only ever stores its SHA-256 (`appointments.hold_owner_session`). 034's voice agent passes its
// own session id through the same hash.
import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";

export const BOOKING_SESSION_COOKIE = "dnm_booking";
const MAX_AGE_SECONDS = 24 * 60 * 60;
const SESSION_RE = /^[A-Za-z0-9_-]{32,128}$/;

export function hashBookingSession(sessionId: string): string {
  return createHash("sha256").update(`booking-session:${sessionId}`).digest("hex");
}

export function newBookingSessionId(): string {
  return randomBytes(32).toString("base64url");
}

/** The current request's session hash, or null without a (well-formed) cookie. */
export async function currentBookingSessionHash(): Promise<string | null> {
  const value = (await cookies()).get(BOOKING_SESSION_COOKIE)?.value;
  return value && SESSION_RE.test(value) ? hashBookingSession(value) : null;
}

/** The existing session id, or a new one (the caller sets it on the response with `bookingSessionCookie`). */
export async function ensureBookingSession(): Promise<{ id: string; hash: string; created: boolean }> {
  const value = (await cookies()).get(BOOKING_SESSION_COOKIE)?.value;
  if (value && SESSION_RE.test(value)) return { id: value, hash: hashBookingSession(value), created: false };
  const id = newBookingSessionId();
  return { id, hash: hashBookingSession(id), created: true };
}

export function bookingSessionCookie(id: string) {
  return {
    name: BOOKING_SESSION_COOKIE,
    value: id,
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  };
}
