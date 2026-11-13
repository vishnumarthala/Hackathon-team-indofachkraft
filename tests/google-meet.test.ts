// Ticket 037: Google Meet for video appointments. Unit checks (token encryption, OAuth state, Meet URL rules, join
// window, event body) and database-backed flows through the route handlers and the outbox worker, with Google mocked at
// the HTTP boundary (oauth2.googleapis.com, www.googleapis.com/calendar/v3): connect (PKCE + state bound to the
// session), FR-5a Google-account check for video holds/confirms, `meet.create` retried after timeouts creating exactly
// one event, reschedule -> patch, cancel -> delete, `invalid_grant` -> expired + notification, manual links, authz and
// secrecy (no refresh token in responses or logs). Synthetic users only; DB part skipped without DATABASE_URL.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { loadEnvConfig } from "@next/env";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { decryptSecret, encryptSecret, openJson, parseEncryptionKey, refreshTokenAad, sealJson, TokenDecryptError } from "@/lib/google/crypto";
import { EVENT_PROPERTY, EVENT_SUMMARY, eventBody } from "@/lib/google/client";
import { joinState, normalizeMeetUrl } from "@/lib/google/meet";
import { checkOAuthState, startOAuth } from "@/lib/google/oauth";
import { bookingWorld, futureSlot, key, type TestProvider } from "./helpers/booking";
import { ctx, post, type TestUser } from "./helpers/world";

loadEnvConfig(process.cwd(), false, { info: () => {}, error: () => {} });
const enabled = Boolean(process.env.DATABASE_URL) && process.env.SKIP_DB_TESTS !== "1";

const KEY = randomBytes(32).toString("base64");
const CLIENT_ID = "test-client.apps.googleusercontent.com";
const CLIENT_SECRET = "test-client-secret";
const APP = "http://localhost:3999";
const GOOGLE_REQUIRED = "Link your Google account to book a video consultation";

const session = vi.hoisted(() => ({ user: null as null | { id: string; email?: string }, cookies: new Map<string, string>() }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getAuthenticatedUser: vi.fn(async () => session.user) };
});
vi.mock("next/cache", () => ({ revalidateTag: vi.fn(), unstable_cache: (fn: () => unknown) => fn }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (session.cookies.has(name) ? { name, value: session.cookies.get(name)! } : undefined),
    getAll: () => [...session.cookies].map(([name, value]) => ({ name, value })),
    has: (name: string) => session.cookies.has(name),
  }),
  headers: async () => ({ get: () => null }),
}));

// ---------- unit ----------

describe("token encryption (AES-256-GCM)", () => {
  const key = parseEncryptionKey(KEY);
  const aad = refreshTokenAad("00000000-0000-4000-8000-000000000001");

  it("round-trips and never stores the plaintext", () => {
    const blob = encryptSecret("1//refresh-token-synthetic", aad, key);
    expect(blob.includes(Buffer.from("refresh-token-synthetic"))).toBe(false);
    expect(decryptSecret(blob, aad, key)).toBe("1//refresh-token-synthetic");
    // A fresh IV every time.
    expect(encryptSecret("x", aad, key).equals(encryptSecret("x", aad, key))).toBe(false);
  });

  it("detects tampering, another row (AAD) and another key", () => {
    const blob = encryptSecret("1//refresh-token-synthetic", aad, key);
    for (const index of [0, 5, 20, blob.length - 1]) {
      const bad = Buffer.from(blob);
      bad[index] ^= 0x01;
      expect(() => decryptSecret(bad, aad, key), `byte ${index}`).toThrow(TokenDecryptError);
    }
    expect(() => decryptSecret(blob, refreshTokenAad("00000000-0000-4000-8000-000000000002"), key)).toThrow(TokenDecryptError);
    expect(() => decryptSecret(blob, aad, randomBytes(32))).toThrow(TokenDecryptError);
    expect(() => decryptSecret(blob.subarray(0, 10), aad, key)).toThrow(TokenDecryptError);
  });

  it("rejects keys that are not 32 bytes", () => {
    expect(() => parseEncryptionKey(undefined)).toThrow(/not set/);
    expect(() => parseEncryptionKey(randomBytes(16).toString("base64"))).toThrow(/32 bytes/);
  });

  it("sealed JSON opens only with the same purpose", () => {
    const sealed = sealJson({ a: 1 }, "purpose-a", key);
    expect(openJson(sealed, "purpose-a", key)).toEqual({ a: 1 });
    expect(openJson(sealed, "purpose-b", key)).toBeNull();
    expect(openJson(`${sealed.slice(0, -2)}AA`, "purpose-a", key)).toBeNull();
  });
});

describe("OAuth state bound to the session", () => {
  beforeAll(() => vi.stubEnv("TOKEN_ENCRYPTION_KEY", KEY));
  afterAll(() => vi.unstubAllEnvs());
  const user = "11111111-1111-4111-8111-111111111111";
  const profile = "22222222-2222-4222-8222-222222222222";

  it("accepts the sealed state for the same user only", () => {
    const start = startOAuth(user, profile);
    expect(start.codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const ok = checkOAuthState({ cookie: start.cookie, state: start.state, userId: user });
    expect(ok).toMatchObject({ ok: true, providerProfileId: profile });
    if (ok.ok) expect(createHash("sha256").update(ok.codeVerifier).digest("base64url")).toBe(start.codeChallenge);
    expect(checkOAuthState({ cookie: start.cookie, state: `${start.state}x`, userId: user })).toEqual({ ok: false, reason: "mismatch" });
    expect(checkOAuthState({ cookie: start.cookie, state: null, userId: user })).toEqual({ ok: false, reason: "mismatch" });
    expect(checkOAuthState({ cookie: start.cookie, state: start.state, userId: profile })).toEqual({ ok: false, reason: "other_user" });
    expect(checkOAuthState({ cookie: undefined, state: start.state, userId: user })).toEqual({ ok: false, reason: "missing" });
    expect(checkOAuthState({ cookie: `${start.cookie.slice(0, -3)}abc`, state: start.state, userId: user })).toEqual({ ok: false, reason: "missing" });
    expect(checkOAuthState({ cookie: start.cookie, state: start.state, userId: user, now: Date.now() + 11 * 60_000 })).toEqual({ ok: false, reason: "expired" });
  });
});

describe("Meet links and the join window", () => {
  it("accepts only Google Meet rooms (normalised)", () => {
    expect(normalizeMeetUrl("https://meet.google.com/abc-defg-hij")).toBe("https://meet.google.com/abc-defg-hij");
    expect(normalizeMeetUrl(" https://meet.google.com/ABC-defg-hij/?authuser=0#x ")).toBe("https://meet.google.com/abc-defg-hij");
    for (const bad of ["http://meet.google.com/abc-defg-hij", "https://meet.google.com.evil.test/abc-defg-hij", "https://evil.test/meet.google.com/abc",
      "https://zoom.us/j/123", "https://user@meet.google.com/abc-defg-hij", "https://meet.google.com/", "javascript:alert(1)", "https://meet.google.com/a/b", 42]) {
      expect(normalizeMeetUrl(bad), String(bad)).toBeNull();
    }
  });

  it("opens 10 minutes before the start and closes 30 minutes after the end", () => {
    const start = new Date("2026-11-20T05:00:00Z");
    const end = new Date("2026-11-20T05:30:00Z");
    const at = (iso: string) => joinState(start, end, new Date(iso));
    expect(at("2026-11-20T04:49:59Z")).toBe("not_yet");
    expect(at("2026-11-20T04:50:00Z")).toBe("open");
    expect(at("2026-11-20T05:59:59Z")).toBe("open");
    expect(at("2026-11-20T06:00:01Z")).toBe("closed");
  });

  it("event body: Meet conference keyed by the appointment, no attendees, no child data", () => {
    const body = eventBody({ appointmentId: "appt-1", start: "2026-11-20T05:00:00.000Z", end: "2026-11-20T05:30:00.000Z", timeZone: "Asia/Kolkata", description: "app link" });
    expect(body).not.toHaveProperty("attendees");
    expect(body.summary).toBe("DoctorNearMe video consultation");
    expect(body.conferenceData.createRequest).toEqual({ requestId: "appt-1", conferenceSolutionKey: { type: "hangoutsMeet" } });
    expect(body.extendedProperties.private).toEqual({ [EVENT_PROPERTY]: "appt-1" });
  });
});

// ---------- fake Google (HTTP boundary) ----------

type FakeEvent = {
  id: string;
  status: string;
  hangoutLink: string;
  summary: string;
  description: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  extendedProperties: { private: Record<string, string> };
};
type Seen = { method: string; url: URL; body: string };
type Step = "ok" | "timeout" | "timeout_after";

const google = {
  events: new Map<string, FakeEvent>(),
  requests: [] as Seen[],
  codes: new Map<string, string>(),
  refreshTokens: new Set<string>(),
  issued: [] as string[],
  revoked: [] as string[],
  failRefresh: false,
  script: [] as Step[],
  reset() {
    this.requests = [];
    this.script = [];
    this.failRefresh = false;
  },
  calendar(method: string) {
    return this.requests.filter((r) => r.url.hostname === "www.googleapis.com" && r.method === method);
  },
};

const letters = (n: number) => Array.from(randomBytes(n), (b) => String.fromCharCode(97 + (b % 26))).join("");
const idToken = (email: string) => ["e30", Buffer.from(JSON.stringify({ email, email_verified: true })).toString("base64url"), "sig"].join(".");
const realFetch = globalThis.fetch;

async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (!["oauth2.googleapis.com", "www.googleapis.com", "accounts.google.com"].includes(url.hostname)) return realFetch(input, init);
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" ? init.body : "";
  google.requests.push({ method, url, body });
  const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
  const timeout = () => new DOMException("The operation was aborted due to timeout", "TimeoutError");

  if (url.hostname === "oauth2.googleapis.com" && url.pathname === "/token") {
    const form = new URLSearchParams(body);
    if (form.get("client_id") !== CLIENT_ID || form.get("client_secret") !== CLIENT_SECRET) return json(401, { error: "invalid_client" });
    if (form.get("grant_type") === "authorization_code") {
      const challenge = google.codes.get(form.get("code") ?? "");
      google.codes.delete(form.get("code") ?? "");
      const verifier = form.get("code_verifier") ?? "";
      if (!challenge || createHash("sha256").update(verifier).digest("base64url") !== challenge) return json(400, { error: "invalid_grant" });
      if (form.get("redirect_uri") !== `${APP}/api/integrations/google/callback`) return json(400, { error: "redirect_uri_mismatch" });
      const refresh = `1//rt-${randomBytes(24).toString("hex")}`;
      google.refreshTokens.add(refresh);
      google.issued.push(refresh);
      return json(200, {
        access_token: `ya29.at-${randomBytes(8).toString("hex")}`,
        refresh_token: refresh,
        expires_in: 3599,
        token_type: "Bearer",
        scope: "https://www.googleapis.com/auth/userinfo.email openid https://www.googleapis.com/auth/calendar.events",
        id_token: idToken("dr.calendar@example.test"),
      });
    }
    if (form.get("grant_type") === "refresh_token") {
      if (google.failRefresh || !google.refreshTokens.has(form.get("refresh_token") ?? "")) {
        return json(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." });
      }
      return json(200, { access_token: `ya29.at-${randomBytes(8).toString("hex")}`, expires_in: 3599, token_type: "Bearer" });
    }
    return json(400, { error: "unsupported_grant_type" });
  }
  if (url.hostname === "oauth2.googleapis.com" && url.pathname === "/revoke") {
    const token = new URLSearchParams(body).get("token") ?? "";
    google.revoked.push(token);
    google.refreshTokens.delete(token);
    return json(200, {});
  }
  if (url.hostname !== "www.googleapis.com" || !url.pathname.startsWith("/calendar/v3/calendars/primary/events")) return json(404, {});
  if (!/^Bearer ya29\./.test(new Headers(init?.headers).get("Authorization") ?? "")) return json(401, { error: { errors: [{ reason: "authError" }] } });

  const step = google.script.shift() ?? "ok";
  if (step === "timeout") throw timeout();
  const id = decodeURIComponent(url.pathname.split("/events/")[1] ?? "");
  if (!id && method === "GET") {
    const [prop, value] = (url.searchParams.get("privateExtendedProperty") ?? "").split("=");
    const items = [...google.events.values()].filter((e) => e.status !== "cancelled" && e.extendedProperties.private[prop] === value);
    return json(200, { kind: "calendar#events", items });
  }
  if (!id && method === "POST") {
    const input = JSON.parse(body) as Omit<FakeEvent, "id" | "status" | "hangoutLink">;
    const event: FakeEvent = { ...input, id: `ev${randomBytes(8).toString("hex")}`, status: "confirmed", hangoutLink: `https://meet.google.com/${letters(3)}-${letters(4)}-${letters(3)}` };
    google.events.set(event.id, event);
    if (step === "timeout_after") throw timeout(); // created at Google, but the response never arrives
    return json(200, event);
  }
  const event = google.events.get(id);
  if (!event || event.status === "cancelled") return json(404, { error: { errors: [{ reason: "notFound" }] } });
  if (method === "GET") return json(200, event);
  if (method === "PATCH") {
    Object.assign(event, JSON.parse(body));
    return json(200, event);
  }
  if (method === "DELETE") {
    event.status = "cancelled";
    return new Response(null, { status: 204 });
  }
  return json(405, {});
}

// ---------- database + routes ----------

type Json = Record<string, unknown>;
async function call(handler: (req: Request, c: never) => Promise<Response>, req: Request, params?: Record<string, string>) {
  const res = await handler(req, (params ? ctx(params) : undefined) as never);
  const text = await res.text();
  let json: Json = {};
  try {
    json = JSON.parse(text) as Json;
  } catch {
    // redirects have no JSON body
  }
  return { status: res.status, json, text, res };
}

describe.skipIf(!enabled)("Google Meet (database, route handlers, outbox worker, mocked Google)", { timeout: 180_000 }, () => {
  let sql: Sql;
  let world: ReturnType<typeof bookingWorld>;
  let providerA: TestProvider;
  let providerB: TestProvider;
  let videoA: string;
  let clinicA: string;
  let guardianA: { user: TestUser; childId: string };
  let guardianB: { user: TestUser; childId: string };
  const logs: string[] = [];
  let routes: {
    connect: typeof import("@/app/api/integrations/google/connect/route");
    callback: typeof import("@/app/api/integrations/google/callback/route");
    disconnect: typeof import("@/app/api/integrations/google/disconnect/route");
    connection: typeof import("@/app/api/integrations/google/connection/route");
    meetLink: typeof import("@/app/api/appointments/[id]/meet-link/route");
    hold: typeof import("@/app/api/appointments/hold/route");
    confirm: typeof import("@/app/api/appointments/[id]/confirm/route");
    cancel: typeof import("@/app/api/appointments/[id]/cancel/route");
    reschedule: typeof import("@/app/api/appointments/[id]/reschedule/route");
  };
  let runOutbox: typeof import("@/lib/notify/worker").runOutbox;

  const as = (user: TestUser | null) => {
    session.user = user;
    session.cookies.clear();
  };
  const hold = (serviceId: string, start: Date) =>
    call(routes.hold.POST, post("http://localhost/api/appointments/hold", { service_id: serviceId, start: start.toISOString(), idempotency_key: key() }));
  const confirm = (id: string, childId: string) => call(routes.confirm.POST, post(`http://localhost/api/appointments/${id}/confirm`, { child_id: childId }), { id });
  const appointment = async (id: string) =>
    (await sql<{ status: string; meet_status: string | null; meet_url: string | null; google_event_id: string | null }[]>`
      select status, meet_status, meet_url, google_event_id from appointments where id = ${id}`)[0];
  const jobAttempts = async (id: string) =>
    (await sql<{ topic: string; status: string; attempts: number | null; last_error: string | null }[]>`
      select e.topic, e.status, j.attempts, j.last_error from outbox_events e left join outbox_job_attempts j on j.event_id = e.id
      where e.dedup_key like ${`meet:${id}:%`} order by e.id`);
  const eventsFor = (id: string) => [...google.events.values()].filter((e) => e.status !== "cancelled" && e.extendedProperties.private[EVENT_PROPERTY] === id);

  /** Runs the pending Meet jobs of an appointment once (back-off skipped by moving deliver_after to now). */
  async function runMeetJobs(id: string) {
    const rows = await sql<{ id: string }[]>`
      update outbox_events set deliver_after = now() where dedup_key like ${`meet:${id}:%`} and status = 'pending' returning id::text as id`;
    if (rows.length) await runOutbox({ sql, eventIds: rows.map((r) => r.id), appUrl: APP });
    return rows.length;
  }
  /** Fans out one notification topic of an appointment; returns the recipients' user ids. */
  async function fanOut(topic: string, aggregateId: string) {
    const rows = await sql<{ id: string }[]>`select id::text as id from outbox_events where topic = ${topic} and aggregate_id = ${aggregateId}`;
    if (rows.length) await runOutbox({ sql, eventIds: rows.map((r) => r.id), appUrl: APP });
    return sql<{ recipient_user_id: string; channel: string; title: string; body: string; link: string }[]>`
      select n.recipient_user_id, n.channel, n.title, n.body, n.link from notifications n join outbox_events e on e.id = n.event_id
      where e.topic = ${topic} and e.aggregate_id = ${aggregateId} order by n.channel`;
  }
  /** Connect Google Calendar through the real routes (consent at Google simulated by the fake's code store). */
  async function connect(p: TestProvider) {
    as(p.user);
    const start = await call(routes.connect.GET, new Request("http://localhost/api/integrations/google/connect"));
    expect(start.status).toBe(303);
    const location = new URL(start.res.headers.get("location") as string);
    const cookie = /dnm_google_oauth=([^;]+)/.exec(start.res.headers.get("set-cookie") ?? "")?.[1] as string;
    const code = `4/code-${randomUUID()}`;
    google.codes.set(code, location.searchParams.get("code_challenge") as string);
    session.cookies.set("dnm_google_oauth", cookie);
    const back = await call(routes.callback.GET, new Request(`${APP}/api/integrations/google/callback?state=${encodeURIComponent(location.searchParams.get("state") as string)}&code=${encodeURIComponent(code)}`));
    return { start, location, back };
  }
  /** A confirmed video appointment for guardian A (returns its id). */
  async function bookVideo(start: Date) {
    as(guardianA.user);
    const h = await hold(videoA, start);
    expect(h.status, JSON.stringify(h.json)).toBe(201);
    const c = await confirm(h.json.appointment_id as string, guardianA.childId);
    expect(c.status, JSON.stringify(c.json)).toBe(200);
    return h.json.appointment_id as string;
  }

  beforeAll(async () => {
    vi.stubEnv("DEMO_MODE", "true");
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", KEY);
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", CLIENT_ID);
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", CLIENT_SECRET);
    vi.stubEnv("NEXT_PUBLIC_APP_URL", APP);
    vi.stubGlobal("fetch", fakeFetch);
    for (const level of ["log", "info", "warn", "error"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logs.push(args.map(String).join(" ")));
    }
    sql = postgres(process.env.DATABASE_URL as string, { max: 4, prepare: false, onnotice: () => {} });
    const db = (await import("@/lib/db")).supabaseAdmin();
    world = bookingWorld(sql, db, "t037");
    providerA = await world.provider("pa");
    providerB = await world.provider("pb");
    videoA = await world.service(providerA, { mode: "video", duration: 30, payment: "free" });
    clinicA = await world.service(providerA, { duration: 30, payment: "free" });
    guardianA = await world.guardian("ga");
    guardianB = await world.guardian("gb");
    routes = {
      connect: await import("@/app/api/integrations/google/connect/route"),
      callback: await import("@/app/api/integrations/google/callback/route"),
      disconnect: await import("@/app/api/integrations/google/disconnect/route"),
      connection: await import("@/app/api/integrations/google/connection/route"),
      meetLink: await import("@/app/api/appointments/[id]/meet-link/route"),
      hold: await import("@/app/api/appointments/hold/route"),
      confirm: await import("@/app/api/appointments/[id]/confirm/route"),
      cancel: await import("@/app/api/appointments/[id]/cancel/route"),
      reschedule: await import("@/app/api/appointments/[id]/reschedule/route"),
    };
    ({ runOutbox } = await import("@/lib/notify/worker"));
  });

  beforeEach(async () => {
    google.reset();
    const { holdLimiter } = await import("@/lib/booking/rate-limit");
    holdLimiter.reset();
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await world?.cleanup();
    await sql?.end({ timeout: 5 });
  });

  it("FR-2 connect: PKCE + state, encrypted refresh token, nothing secret in the response", async () => {
    const { location, back, start } = await connect(providerA);
    expect(location.origin + location.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(location.searchParams)).toMatchObject({
      client_id: CLIENT_ID,
      redirect_uri: `${APP}/api/integrations/google/callback`,
      response_type: "code",
      access_type: "offline",
      prompt: "consent",
      code_challenge_method: "S256",
      scope: "openid email https://www.googleapis.com/auth/calendar.events",
    });
    expect(start.res.headers.get("set-cookie")).toMatch(/HttpOnly/i);
    expect(back.status).toBe(303);
    expect(back.res.headers.get("location")).toBe(`${APP}/dashboard/settings/integrations?connected=1`);
    const token = google.issued.at(-1) as string;
    const [row] = await sql<{ google_email: string; status: string; scopes: string[]; refresh_token_encrypted: Buffer }[]>`
      select google_email, status, scopes, refresh_token_encrypted from provider_google_connections where provider_profile_id = ${providerA.profileId}`;
    expect(row).toMatchObject({ google_email: "dr.calendar@example.test", status: "active" });
    expect(row.scopes).toContain("https://www.googleapis.com/auth/calendar.events");
    expect(row.refresh_token_encrypted.includes(Buffer.from(token))).toBe(false);
    expect(decryptSecret(row.refresh_token_encrypted, refreshTokenAad(providerA.profileId), parseEncryptionKey(KEY))).toBe(token);
    for (const r of [start, back]) expect(`${r.text}${JSON.stringify([...r.res.headers])}`).not.toContain(token);
    const audit = await sql`select actor_user_id, details from audit_events where action = 'google_calendar.connected' and entity_id = ${providerA.profileId}`;
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0].details)).not.toContain(token);

    // The provider's own connection view: no token.
    const own = await call(routes.connection.GET, new Request("http://localhost/api/integrations/google/connection"));
    expect(own.status).toBe(200);
    expect(own.json.connection).toMatchObject({ google_email: "dr.calendar@example.test", status: "active" });
    expect(own.text).not.toContain(token);
    expect(own.text).not.toContain("refresh_token");
  });

  it("FR-2 OAuth state mismatch (or another user's flow) is rejected and stores nothing", async () => {
    as(providerB.user);
    const start = await call(routes.connect.GET, new Request("http://localhost/api/integrations/google/connect"));
    const location = new URL(start.res.headers.get("location") as string);
    const cookie = /dnm_google_oauth=([^;]+)/.exec(start.res.headers.get("set-cookie") ?? "")?.[1] as string;
    const code = `4/code-${randomUUID()}`;
    google.codes.set(code, location.searchParams.get("code_challenge") as string);
    session.cookies.set("dnm_google_oauth", cookie);
    const wrong = await call(routes.callback.GET, new Request(`${APP}/api/integrations/google/callback?state=forged-state&code=${encodeURIComponent(code)}`));
    expect(wrong.status).toBe(303);
    expect(wrong.res.headers.get("location")).toBe(`${APP}/dashboard/settings/integrations?error=state`);
    // provider A replaying B's cookie + state: bound to B's session.
    session.user = providerA.user;
    const replay = await call(routes.callback.GET, new Request(`${APP}/api/integrations/google/callback?state=${encodeURIComponent(location.searchParams.get("state") as string)}&code=${encodeURIComponent(code)}`));
    expect(replay.res.headers.get("location")).toContain("error=state");
    expect(google.requests.filter((r) => r.url.pathname === "/token")).toHaveLength(0);
    expect(await sql`select 1 from provider_google_connections where provider_profile_id = ${providerB.profileId}`).toHaveLength(0);
  });

  it("E-3 provider_b cannot read provider_a's connection (404); guardians get 403", async () => {
    as(providerB.user);
    const other = await call(routes.connection.GET, new Request(`http://localhost/api/integrations/google/connection?profile_id=${providerA.profileId}`));
    expect(other.status).toBe(404);
    expect(other.text).not.toContain("dr.calendar");
    as(guardianA.user);
    expect((await call(routes.connection.GET, new Request("http://localhost/api/integrations/google/connection"))).status).toBe(403);
    expect((await call(routes.disconnect.POST, new Request("http://localhost/x", { method: "POST" }))).status).toBe(403);
  });

  it("FR-5a / E-1a: no Google account -> 422 for video holds and confirms; in-clinic unaffected", async () => {
    as(guardianA.user);
    const video = await hold(videoA, futureSlot(30));
    expect(video.status).toBe(422);
    expect(video.json).toEqual({ error: GOOGLE_REQUIRED, code: "google_account_required" });
    as(null);
    expect((await hold(videoA, futureSlot(30))).json.code).toBe("google_account_required");
    as(guardianA.user);
    const clinic = await hold(clinicA, futureSlot(31));
    expect(clinic.status).toBe(201);

    // After linking Google (019 linkIdentity), the video hold succeeds.
    await world.linkGoogle(guardianA.user);
    const ok = await hold(videoA, futureSlot(32));
    expect(ok.status).toBe(201);
    // Unlinking before confirming: the confirm is refused too.
    await sql`delete from auth.identities where user_id = ${guardianA.user.id} and provider = 'google'`;
    const refused = await confirm(ok.json.appointment_id as string, guardianA.childId);
    expect(refused.status).toBe(422);
    expect(refused.json.error).toBe(GOOGLE_REQUIRED);
    expect((await appointment(ok.json.appointment_id as string)).status).toBe("held");
    await world.linkGoogle(guardianA.user);
    expect((await confirm(ok.json.appointment_id as string, guardianA.childId)).status).toBe(200);
  });

  it("FR-3 / E-1: confirm -> meet.create -> event without attendees (sendUpdates=none) -> meet_ready for both", async () => {
    const id = await bookVideo(futureSlot(40));
    expect((await appointment(id)).meet_status).toBe("pending");
    expect(await jobAttempts(id)).toMatchObject([{ topic: "meet.create", status: "pending" }]);

    await runMeetJobs(id);
    const row = await appointment(id);
    expect(row.meet_status).toBe("created");
    expect(row.meet_url).toMatch(/^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/);
    const inserts = google.calendar("POST");
    expect(inserts).toHaveLength(1);
    expect(inserts[0].url.searchParams.get("sendUpdates")).toBe("none");
    expect(inserts[0].url.searchParams.get("conferenceDataVersion")).toBe("1");
    const body = JSON.parse(inserts[0].body) as Json;
    expect(body).not.toHaveProperty("attendees");
    expect(body.summary).toBe(EVENT_SUMMARY);
    expect((body.conferenceData as { createRequest: { requestId: string } }).createRequest.requestId).toBe(id);
    expect((body.extendedProperties as { private: Json }).private).toEqual({ [EVENT_PROPERTY]: id });
    // No child name, no guardian email anywhere in the request.
    expect(inserts[0].body).not.toContain("child (synthetic)");
    expect(inserts[0].body).not.toContain(guardianA.user.email);
    expect(row.google_event_id).toBe(eventsFor(id)[0].id);

    const sent = await fanOut("appointment.meet_ready", id);
    expect(new Set(sent.map((n) => n.recipient_user_id))).toEqual(new Set([guardianA.user.id, providerA.user.id]));
    expect(sent.map((n) => n.channel).sort()).toEqual(["email", "email", "in_app", "in_app", "whatsapp", "whatsapp"]);
    for (const n of sent) {
      expect(n.body).not.toContain(row.meet_url as string); // the link stays in the app
      expect(n.body).not.toContain("child (synthetic)");
    }
  });

  it("FR-3 meet.create retried 3x after timeouts creates exactly one event (extended-property lookup)", async () => {
    const id = await bookVideo(futureSlot(44));
    // Attempt 1: lookup ok, insert reaches Google but times out. Attempts 2 and 3: the lookup times out.
    google.script = ["ok", "timeout_after", "timeout", "timeout"];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await runMeetJobs(id);
      expect((await appointment(id)).meet_status, `attempt ${attempt}`).toBe("pending");
    }
    const [job] = await jobAttempts(id);
    expect(job).toMatchObject({ topic: "meet.create", status: "pending", attempts: 3 });
    expect(job.last_error).toMatch(/timeout/);
    await runMeetJobs(id); // attempt 4 finds the event created by attempt 1
    expect(await jobAttempts(id)).toMatchObject([{ status: "fanned_out", attempts: 4, last_error: null }]);
    expect(eventsFor(id)).toHaveLength(1);
    expect(google.calendar("POST")).toHaveLength(1);
    const row = await appointment(id);
    expect(row).toMatchObject({ meet_status: "created", google_event_id: eventsFor(id)[0].id, meet_url: eventsFor(id)[0].hangoutLink });
    // A further run (e.g. a duplicate drain) does nothing.
    expect(await runMeetJobs(id)).toBe(0);
  });

  it("FR-3 reschedule patches the same event (same link); cancel deletes it", async () => {
    const id = await bookVideo(futureSlot(48));
    await runMeetJobs(id);
    const before = await appointment(id);
    as(guardianA.user);
    const newStart = futureSlot(52);
    const moved = await call(routes.reschedule.POST, post(`http://localhost/api/appointments/${id}/reschedule`, { start: newStart.toISOString() }), { id });
    expect(moved.status, JSON.stringify(moved.json)).toBe(200);
    const newId = (moved.json.appointment as Json).id as string;
    expect(await appointment(newId)).toMatchObject({ meet_url: before.meet_url, google_event_id: before.google_event_id, meet_status: "created" });
    expect(await jobAttempts(newId)).toMatchObject([{ topic: "meet.update", status: "pending" }]);
    expect(await jobAttempts(id)).toHaveLength(1); // no delete for the old half of a reschedule

    await runMeetJobs(newId);
    const patches = google.calendar("PATCH");
    expect(patches).toHaveLength(1);
    expect(patches[0].url.pathname).toContain(before.google_event_id as string);
    expect(patches[0].url.searchParams.get("sendUpdates")).toBe("none");
    const event = google.events.get(before.google_event_id as string) as FakeEvent;
    expect(new Date(event.start.dateTime).toISOString()).toBe(newStart.toISOString());
    expect(event.extendedProperties.private[EVENT_PROPERTY]).toBe(newId);
    expect(google.calendar("POST")).toHaveLength(1); // only the original create: the move is a patch

    const cancelled = await call(routes.cancel.POST, post(`http://localhost/api/appointments/${newId}/cancel`, {}), { id: newId });
    expect(cancelled.status).toBe(200);
    await runMeetJobs(newId);
    const deletes = google.calendar("DELETE");
    expect(deletes).toHaveLength(1);
    expect(deletes[0].url.pathname).toContain(before.google_event_id as string);
    expect(deletes[0].url.searchParams.get("sendUpdates")).toBe("none");
    expect(event.status).toBe("cancelled");
    expect((await appointment(newId)).google_event_id).toBeNull();
  });

  it("cancel before the link exists: the create job removes an event an earlier timed-out attempt made", async () => {
    const id = await bookVideo(futureSlot(56));
    google.script = ["ok", "timeout_after"];
    await runMeetJobs(id);
    expect(eventsFor(id)).toHaveLength(1);
    as(guardianA.user);
    expect((await call(routes.cancel.POST, post(`http://localhost/api/appointments/${id}/cancel`, {}), { id })).status).toBe(200);
    await runMeetJobs(id);
    expect(eventsFor(id)).toHaveLength(0);
  });

  it("FR-2 invalid_grant on refresh -> connection expired, provider notified, appointment failed", async () => {
    const id = await bookVideo(futureSlot(60));
    google.failRefresh = true;
    await runMeetJobs(id);
    expect((await sql`select status from provider_google_connections where provider_profile_id = ${providerA.profileId}`)[0].status).toBe("expired");
    expect(await appointment(id)).toMatchObject({ meet_status: "failed", meet_url: null });
    expect(await jobAttempts(id)).toMatchObject([{ status: "fanned_out", attempts: 1, last_error: "google_token_expired" }]);
    const reconnect = await fanOut("google_calendar.reconnect_required", providerA.profileId);
    expect(reconnect.map((n) => [n.recipient_user_id, n.channel])).toEqual([
      [providerA.user.id, "email"],
      [providerA.user.id, "in_app"],
    ]);
    expect(reconnect[0].title).toBe("Reconnect Google Calendar");
    expect(reconnect[0].link).toBe("/dashboard/settings/integrations");
    const failed = await fanOut("appointment.meet_failed", id);
    expect(failed.map((n) => n.recipient_user_id)).toEqual([providerA.user.id, providerA.user.id]);
    expect(failed[0].title).toBe("Add a video link");
    // Reconnecting makes it active again.
    google.failRefresh = false;
    expect((await connect(providerA)).back.res.headers.get("location")).toContain("connected=1");
  });

  it("E-2 disconnect revokes and deletes; next booking fails -> manual Meet link (non-Meet 400, provider_b 404)", async () => {
    as(providerA.user);
    const token = google.issued.at(-1) as string;
    const off = await call(routes.disconnect.POST, new Request("http://localhost/x", { method: "POST" }));
    expect(off.status).toBe(200);
    expect(off.json).toEqual({ disconnected: true, revoked: true });
    expect(google.revoked).toContain(token);
    expect(off.text).not.toContain(token);
    expect(await sql`select 1 from provider_google_connections where provider_profile_id = ${providerA.profileId}`).toHaveLength(0);
    expect((await call(routes.disconnect.POST, new Request("http://localhost/x", { method: "POST" }))).status).toBe(404);

    const id = await bookVideo(futureSlot(64));
    await runMeetJobs(id);
    expect(await appointment(id)).toMatchObject({ meet_status: "failed", meet_url: null });
    expect(await jobAttempts(id)).toMatchObject([{ status: "fanned_out", last_error: "google_not_connected" }]);

    const setLink = (url: string) => call(routes.meetLink.POST, post(`http://localhost/api/appointments/${id}/meet-link`, { url }), { id });
    as(providerB.user);
    expect((await setLink("https://meet.google.com/abc-defg-hij")).status).toBe(404);
    as(guardianA.user);
    expect((await setLink("https://meet.google.com/abc-defg-hij")).status).toBe(403);
    as(providerA.user);
    expect((await setLink("https://zoom.us/j/123456")).status).toBe(400);
    expect((await setLink("https://meet.google.com.evil.test/abc-defg-hij")).status).toBe(400);
    const ok = await setLink("https://meet.google.com/abc-defg-hij?authuser=0");
    expect(ok.status).toBe(200);
    expect(ok.json).toEqual({ meet_url: "https://meet.google.com/abc-defg-hij", meet_status: "manual" });
    expect(await appointment(id)).toMatchObject({ meet_status: "manual", meet_url: "https://meet.google.com/abc-defg-hij" });
    const { getMeetInfo } = await import("@/lib/google/meet");
    expect((await getMeetInfo([id])).get(id)).toEqual({ meet_status: "manual", meet_url: "https://meet.google.com/abc-defg-hij" });
    const ready = await fanOut("appointment.meet_ready", id);
    expect(ready.map((n) => n.recipient_user_id)).toContain(guardianA.user.id);
    expect(await sql`select 1 from audit_events where action = 'appointment.meet_link_set' and entity_id = ${id}`).toHaveLength(1);
    // In-clinic appointments cannot get a Meet link.
    as(guardianB.user);
    const clinic = await hold(clinicA, futureSlot(66));
    await confirm(clinic.json.appointment_id as string, guardianB.childId);
    as(providerA.user);
    const clinicId = clinic.json.appointment_id as string;
    expect((await call(routes.meetLink.POST, post("http://localhost/x", { url: "https://meet.google.com/abc-defg-hij" }), { id: clinicId })).status).toBe(409);
    expect((await appointment(clinicId)).meet_status).toBe("not_needed");
  });

  it("NFR-1: no refresh token in any log line", () => {
    expect(google.issued.length).toBeGreaterThan(1);
    const all = logs.join("\n");
    for (const token of google.issued) expect(all).not.toContain(token);
    expect(all).not.toMatch(/1\/\/rt-/);
  });
});
