// 037: the small Google client. Everything DoctorNearMe needs from Google goes through `GoogleApi`:
// OAuth (authorize URL, code exchange with PKCE, refresh, revoke) and Calendar events on the provider's primary
// calendar (find by our private extended property, insert with a Meet conference, get, patch, delete).
//
// Backends (`googleBackend()`):
//   * live - GOOGLE_OAUTH_CLIENT_ID + GOOGLE_OAUTH_CLIENT_SECRET set: real HTTPS calls (tests mock `fetch` for
//            oauth2.googleapis.com and www.googleapis.com/calendar/v3);
//   * demo - DEMO_MODE without a client: an in-process fake Google (consent screen = an instant redirect, fake Meet
//            links). Nothing leaves the machine;
//   * off  - neither: providers cannot connect; video appointments fall back to manual links (FR-4).
// Tokens and Google error bodies are never logged (NFR-1): errors carry a short code and the HTTP status only.
import { createHash, randomBytes } from "node:crypto";
import { env } from "@/lib/env";
import { encryptionKeyConfigured } from "./crypto";

export const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const CALENDAR_EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events";
/** `openid email` only to learn which Google account was connected (shown as "Connected as ..."). */
export const OAUTH_SCOPES = ["openid", "email", CALENDAR_SCOPE] as const;
/** Private extended property on our calendar events: retries look the event up instead of creating a duplicate. */
export const EVENT_PROPERTY = "dnm_appointment_id";
export const EVENT_SUMMARY = "DoctorNearMe video consultation";
export const GOOGLE_TIMEOUT_MS = 10_000;

export type GoogleBackend = "live" | "demo" | "off";

export function googleBackend(): GoogleBackend {
  if (env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET) return "live";
  return env.DEMO_MODE ? "demo" : "off";
}

/** Providers can connect: a backend and a valid TOKEN_ENCRYPTION_KEY. */
export function googleConnectAvailable(): boolean {
  return googleBackend() !== "off" && encryptionKeyConfigured();
}

export function googleRedirectUri(): string {
  return `${env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "")}/api/integrations/google/callback`;
}

/** A Google failure. `permanent` = retrying cannot help (bad request, revoked grant, missing permission). */
export class GoogleError extends Error {
  constructor(
    readonly code: string,
    readonly permanent: boolean,
    readonly status: number | null = null,
  ) {
    super(status ? `${code} (${status})` : code);
    this.name = "GoogleError";
  }
}

export type GoogleTokens = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
};

export type CalendarEvent = {
  id: string;
  status?: string;
  hangoutLink?: string;
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
  conferenceData?: {
    createRequest?: { status?: { statusCode?: string } };
    entryPoints?: { entryPointType?: string; uri?: string }[];
  };
  extendedProperties?: { private?: Record<string, string> };
};

export type EventTimes = { start: string; end: string; timeZone: string };
export type NewEvent = EventTimes & { appointmentId: string; description: string };

export interface GoogleApi {
  authorizeUrl(params: { state: string; codeChallenge: string; redirectUri: string }): string;
  exchangeCode(code: string, codeVerifier: string, redirectUri: string): Promise<GoogleTokens>;
  refresh(refreshToken: string): Promise<GoogleTokens>;
  revoke(token: string): Promise<void>;
  findEvents(accessToken: string, appointmentId: string): Promise<CalendarEvent[]>;
  getEvent(accessToken: string, eventId: string): Promise<CalendarEvent | null>;
  insertEvent(accessToken: string, event: NewEvent): Promise<CalendarEvent>;
  /** null when the event no longer exists. */
  patchEvent(accessToken: string, eventId: string, patch: EventTimes & { appointmentId: string; description: string }): Promise<CalendarEvent | null>;
  /** false when the event was already gone. */
  deleteEvent(accessToken: string, eventId: string): Promise<boolean>;
}

// ---------- PKCE ----------

export function newCodeVerifier(): string {
  return randomBytes(48).toString("base64url");
}

export function codeChallengeOf(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** The email claim of an id_token received directly from Google's token endpoint over TLS (OIDC 3.1.3.7: no
 * signature check needed for a token-endpoint response). */
export function emailFromIdToken(idToken: string | undefined): string | null {
  const part = idToken?.split(".")[1];
  if (!part) return null;
  try {
    const claims = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as { email?: unknown; email_verified?: unknown };
    return typeof claims.email === "string" && claims.email.includes("@") ? claims.email.toLowerCase().slice(0, 320) : null;
  } catch {
    return null;
  }
}

// ---------- event bodies (FR-3: no attendees, no child data) ----------

/** Events.insert body. Never attendees (the guardian's email must not reach the provider's calendar, D-5). */
export function eventBody(event: NewEvent) {
  return {
    summary: EVENT_SUMMARY,
    description: event.description,
    start: { dateTime: event.start, timeZone: event.timeZone },
    end: { dateTime: event.end, timeZone: event.timeZone },
    conferenceData: {
      // D-2: requestId = appointment id, so Google treats a repeated create request as the same conference.
      createRequest: { requestId: event.appointmentId, conferenceSolutionKey: { type: "hangoutsMeet" } },
    },
    extendedProperties: { private: { [EVENT_PROPERTY]: event.appointmentId } },
    visibility: "private",
    guestsCanInviteOthers: false,
    guestsCanSeeOtherGuests: false,
    reminders: { useDefault: true },
  };
}

export function meetLinkOf(event: CalendarEvent): string | null {
  const link = event.hangoutLink ?? event.conferenceData?.entryPoints?.find((e) => e.entryPointType === "video")?.uri;
  return link && /^https:\/\/meet\.google\.com\/[a-z0-9-]+$/.test(link) ? link : null;
}

// ---------- live backend (HTTPS) ----------

type FetchLike = typeof fetch;

async function call(fetchImpl: FetchLike, url: string, init: RequestInit, code: string): Promise<Response> {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS), cache: "no-store" });
  } catch (err) {
    const name = (err as { name?: string } | null)?.name;
    throw new GoogleError(name === "TimeoutError" || name === "AbortError" ? `${code}_timeout` : `${code}_network`, false);
  }
}

async function jsonOf<T>(res: Response): Promise<T | null> {
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** Token endpoint errors: `invalid_grant` (revoked / expired, e.g. 7-day tokens of unverified apps) is permanent. */
async function tokenError(res: Response, code: string): Promise<GoogleError> {
  const body = await jsonOf<{ error?: string }>(res);
  if (body?.error === "invalid_grant") return new GoogleError("invalid_grant", true, res.status);
  if (res.status >= 500 || res.status === 429) return new GoogleError(`${code}_unavailable`, false, res.status);
  return new GoogleError(`${code}_${body?.error && /^[a-z_]{1,40}$/.test(body.error) ? body.error : "rejected"}`, true, res.status);
}

/** Calendar errors: 401 (stale access token), 429, 5xx and rate-limit 403s are retried; other 4xx are permanent. */
async function calendarError(res: Response, code: string): Promise<GoogleError> {
  const body = await jsonOf<{ error?: { errors?: { reason?: string }[] } }>(res);
  const reasons = (body?.error?.errors ?? []).map((e) => e.reason ?? "");
  const rateLimited = reasons.some((r) => /rateLimitExceeded|userRateLimitExceeded|quotaExceeded/.test(r));
  if (res.status === 401 || res.status === 429 || res.status >= 500 || (res.status === 403 && rateLimited)) {
    return new GoogleError(`${code}_unavailable`, false, res.status);
  }
  return new GoogleError(`${code}_rejected`, true, res.status);
}

export function liveGoogle(opts: { clientId: string; clientSecret: string; fetch?: FetchLike }): GoogleApi {
  const f: FetchLike = (url, init) => (opts.fetch ?? globalThis.fetch)(url, init);
  const form = (values: Record<string, string>) => ({
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(values).toString(),
  });
  const auth = (token: string, extra: Record<string, string> = {}) => ({ Authorization: `Bearer ${token}`, ...extra });
  const eventUrl = (id: string, query = "") => `${CALENDAR_EVENTS_URL}/${encodeURIComponent(id)}${query}`;

  return {
    authorizeUrl({ state, codeChallenge, redirectUri }) {
      const params = new URLSearchParams({
        client_id: opts.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: OAUTH_SCOPES.join(" "),
        access_type: "offline",
        prompt: "consent",
        include_granted_scopes: "true",
        state,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
      });
      return `${GOOGLE_AUTHORIZE_URL}?${params}`;
    },
    async exchangeCode(code, codeVerifier, redirectUri) {
      const res = await call(f, GOOGLE_TOKEN_URL, form({
        code,
        client_id: opts.clientId,
        client_secret: opts.clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
        code_verifier: codeVerifier,
      }), "token_exchange");
      if (!res.ok) throw await tokenError(res, "token_exchange");
      const body = await jsonOf<GoogleTokens>(res);
      if (!body?.access_token) throw new GoogleError("token_exchange_invalid", true, res.status);
      return body;
    },
    async refresh(refreshToken) {
      const res = await call(f, GOOGLE_TOKEN_URL, form({
        refresh_token: refreshToken,
        client_id: opts.clientId,
        client_secret: opts.clientSecret,
        grant_type: "refresh_token",
      }), "token_refresh");
      if (!res.ok) throw await tokenError(res, "token_refresh");
      const body = await jsonOf<GoogleTokens>(res);
      if (!body?.access_token) throw new GoogleError("token_refresh_invalid", false, res.status);
      return body;
    },
    async revoke(token) {
      const res = await call(f, GOOGLE_REVOKE_URL, form({ token }), "revoke");
      // 400 invalid_token: already revoked or expired - the goal is reached.
      if (!res.ok && res.status !== 400) throw new GoogleError("revoke_failed", res.status < 500, res.status);
    },
    async findEvents(accessToken, appointmentId) {
      const query = new URLSearchParams({ privateExtendedProperty: `${EVENT_PROPERTY}=${appointmentId}`, maxResults: "10", showDeleted: "false" });
      const res = await call(f, `${CALENDAR_EVENTS_URL}?${query}`, { headers: auth(accessToken) }, "events_list");
      if (!res.ok) throw await calendarError(res, "events_list");
      const body = await jsonOf<{ items?: CalendarEvent[] }>(res);
      return (body?.items ?? []).filter((e) => e.status !== "cancelled");
    },
    async getEvent(accessToken, eventId) {
      const res = await call(f, eventUrl(eventId), { headers: auth(accessToken) }, "events_get");
      if (res.status === 404 || res.status === 410) return null;
      if (!res.ok) throw await calendarError(res, "events_get");
      const body = await jsonOf<CalendarEvent>(res);
      return body && body.status !== "cancelled" ? body : null;
    },
    async insertEvent(accessToken, event) {
      const res = await call(
        f,
        `${CALENDAR_EVENTS_URL}?conferenceDataVersion=1&sendUpdates=none`,
        { method: "POST", headers: auth(accessToken, { "Content-Type": "application/json" }), body: JSON.stringify(eventBody(event)) },
        "events_insert",
      );
      if (!res.ok) throw await calendarError(res, "events_insert");
      const body = await jsonOf<CalendarEvent>(res);
      if (!body?.id) throw new GoogleError("events_insert_invalid", false, res.status);
      return body;
    },
    async patchEvent(accessToken, eventId, patch) {
      const res = await call(
        f,
        eventUrl(eventId, "?conferenceDataVersion=1&sendUpdates=none"),
        {
          method: "PATCH",
          headers: auth(accessToken, { "Content-Type": "application/json" }),
          body: JSON.stringify({
            description: patch.description,
            start: { dateTime: patch.start, timeZone: patch.timeZone },
            end: { dateTime: patch.end, timeZone: patch.timeZone },
            extendedProperties: { private: { [EVENT_PROPERTY]: patch.appointmentId } },
          }),
        },
        "events_patch",
      );
      if (res.status === 404 || res.status === 410) return null;
      if (!res.ok) throw await calendarError(res, "events_patch");
      return jsonOf<CalendarEvent>(res);
    },
    async deleteEvent(accessToken, eventId) {
      const res = await call(f, eventUrl(eventId, "?sendUpdates=none"), { method: "DELETE", headers: auth(accessToken) }, "events_delete");
      if (res.status === 404 || res.status === 410) return false;
      if (!res.ok) throw await calendarError(res, "events_delete");
      return true;
    },
  };
}

// ---------- demo backend (DEMO_MODE, no client configured) ----------

type DemoState = {
  codes: Map<string, { challenge: string; expires: number }>;
  refreshTokens: Set<string>;
  events: Map<string, CalendarEvent & { deleted?: boolean }>;
};

const demoGlobal = globalThis as unknown as { __dnmDemoGoogle?: DemoState };

function demoState(): DemoState {
  demoGlobal.__dnmDemoGoogle ??= { codes: new Map(), refreshTokens: new Set(), events: new Map() };
  return demoGlobal.__dnmDemoGoogle;
}

export const DEMO_GOOGLE_EMAIL = "calendar.demo@example.test";
const letters = (n: number) => Array.from(randomBytes(n), (b) => String.fromCharCode(97 + (b % 26))).join("");

/** Demo consent screen: GET /api/integrations/google/demo-authorize issues a one-time code bound to the PKCE
 * challenge and sends the browser straight back to the callback. */
export function demoIssueCode(codeChallenge: string): string {
  const code = `demo-code-${randomBytes(16).toString("hex")}`;
  demoState().codes.set(code, { challenge: codeChallenge, expires: Date.now() + 5 * 60_000 });
  return code;
}

export function demoGoogle(): GoogleApi {
  const s = demoState();
  const fakeIdToken = () =>
    ["e30", Buffer.from(JSON.stringify({ email: DEMO_GOOGLE_EMAIL, email_verified: true })).toString("base64url"), "demo"].join(".");
  const live = (id: string) => {
    const event = s.events.get(id);
    return event && !event.deleted ? event : null;
  };
  return {
    authorizeUrl({ state, codeChallenge }) {
      const params = new URLSearchParams({ state, code_challenge: codeChallenge });
      return `/api/integrations/google/demo-authorize?${params}`;
    },
    async exchangeCode(code, codeVerifier) {
      const entry = s.codes.get(code);
      s.codes.delete(code);
      if (!entry || entry.expires < Date.now() || entry.challenge !== codeChallengeOf(codeVerifier)) {
        throw new GoogleError("token_exchange_invalid_grant", true, 400);
      }
      const refresh = `demo-refresh-${randomBytes(24).toString("hex")}`;
      s.refreshTokens.add(refresh);
      return { access_token: `demo-access-${randomBytes(16).toString("hex")}`, refresh_token: refresh, expires_in: 3599, scope: OAUTH_SCOPES.join(" "), id_token: fakeIdToken() };
    },
    async refresh(refreshToken) {
      // Other processes (outbox:run) share no memory with the dev server: any demo refresh token is accepted there.
      if (!refreshToken.startsWith("demo-refresh-")) throw new GoogleError("invalid_grant", true, 400);
      return { access_token: `demo-access-${randomBytes(16).toString("hex")}`, expires_in: 3599, scope: OAUTH_SCOPES.join(" ") };
    },
    async revoke(token) {
      s.refreshTokens.delete(token);
    },
    async findEvents(_accessToken, appointmentId) {
      return [...s.events.values()].filter((e) => !e.deleted && e.extendedProperties?.private?.[EVENT_PROPERTY] === appointmentId);
    },
    async getEvent(_accessToken, eventId) {
      return live(eventId);
    },
    async insertEvent(_accessToken, event) {
      const id = `demo${randomBytes(12).toString("hex")}`;
      const created: CalendarEvent = {
        id,
        status: "confirmed",
        hangoutLink: `https://meet.google.com/${letters(3)}-${letters(4)}-${letters(3)}`,
        start: { dateTime: event.start, timeZone: event.timeZone },
        end: { dateTime: event.end, timeZone: event.timeZone },
        extendedProperties: { private: { [EVENT_PROPERTY]: event.appointmentId } },
      };
      s.events.set(id, created);
      return created;
    },
    async patchEvent(_accessToken, eventId, patch) {
      const event = live(eventId);
      if (!event) return null;
      Object.assign(event, {
        start: { dateTime: patch.start, timeZone: patch.timeZone },
        end: { dateTime: patch.end, timeZone: patch.timeZone },
        extendedProperties: { private: { [EVENT_PROPERTY]: patch.appointmentId } },
      });
      return event;
    },
    async deleteEvent(_accessToken, eventId) {
      const event = live(eventId);
      if (!event) return false;
      event.deleted = true;
      return true;
    },
  };
}

export function googleApi(): GoogleApi {
  const backend = googleBackend();
  if (backend === "live") {
    return liveGoogle({ clientId: env.GOOGLE_OAUTH_CLIENT_ID as string, clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET as string });
  }
  if (backend === "demo") return demoGoogle();
  throw new GoogleError("google_not_configured", true);
}
