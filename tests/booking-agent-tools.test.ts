// Ticket 034: voice booking agent. Server tools (search_providers, get_slots, hold_slot) through the real route
// handlers against the local database: shared secret + per-conversation session (401), strict payloads (400), the
// 20-call budget (429), result limits, holds owned by the parent's browser (030 cookie session), one hold per session,
// slot_taken, the audit row, confirm only by a signed-in guardian, the DEMO_MODE script and NFR-1 latency.
// Pure checks (schemas, helpers, access lists) run without a database. Synthetic data only.
import { loadEnvConfig } from "@next/env";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { confirmUrl, MAX_PROVIDERS, MAX_SLOTS, MAX_TOOL_CALLS, partOfDayOf } from "@/lib/agents/booking/constants";
import { DEMO_LINES, dateOf, runDemoScript, type ToolCaller } from "@/lib/agents/booking/demo-script";
import { GetSlotsSchema, HoldSlotSchema, SearchProvidersSchema } from "@/lib/agents/booking/schemas";
import { isProtectedPath } from "@/lib/auth-access";
import { FAMILY_CSP_EXCEPTIONS } from "@/lib/csp";
import { allowedOriginsFor } from "@/lib/privacy/third-party-allowlist";
import { bookingWorld, futureSlot, sessionHash, type TestProvider } from "./helpers/booking";
import { ctx, post, type TestUser } from "./helpers/world";

loadEnvConfig(process.cwd(), false, { info: () => {}, error: () => {} });
const enabled = Boolean(process.env.DATABASE_URL) && process.env.SKIP_DB_TESTS !== "1";

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

const SECRET = "test-secret-034-synthetic";
const ROOT = process.cwd();
const VALID_TOKEN = "A".repeat(43);

// ---------- pure ----------

describe("booking agent: schemas, helpers and access lists", () => {
  it("NFR-2: payload keys outside the schema are rejected (no PII can reach a tool)", () => {
    const base = { booking_session: VALID_TOKEN, locality_text: "Kukatpally" };
    expect(SearchProvidersSchema.safeParse(base).success).toBe(true);
    for (const extra of [{ child_name: "Asha" }, { phone: "9876543210" }, { dob: "2021-01-01" }, { parent_name: "X" }]) {
      expect(SearchProvidersSchema.safeParse({ ...base, ...extra }).success).toBe(false);
    }
    expect(GetSlotsSchema.safeParse({ booking_session: VALID_TOKEN, profile_id: crypto.randomUUID(), service_mode: "video", date_from: "2026-11-14", child_name: "x" }).success).toBe(false);
    expect(HoldSlotSchema.safeParse({ booking_session: VALID_TOKEN, profile_id: crypto.randomUUID(), service_id: crypto.randomUUID(), start: "2026-11-14T04:30:00Z", phone: "1" }).success).toBe(false);
    // A phone number in the place field is refused; a PIN code is fine.
    expect(SearchProvidersSchema.safeParse({ ...base, locality_text: "call me on 98765 43210" }).success).toBe(false);
    expect(SearchProvidersSchema.safeParse({ ...base, locality_text: "500072" }).success).toBe(true);
  });

  it("normalises what an LLM says into the directory vocabulary", () => {
    const parsed = SearchProvidersSchema.parse({ booking_session: VALID_TOKEN, locality_text: " Kukatpally ", type: "Speech therapist", language: "Telugu", mode: "in clinic" });
    expect(parsed).toMatchObject({ locality_text: "Kukatpally", type: "speech_language_pathologist", language: "te", mode: "in_clinic" });
    expect(GetSlotsSchema.parse({ booking_session: VALID_TOKEN, profile_id: crypto.randomUUID(), service_mode: "online", date_from: "2026-11-14", part_of_day: "Morning" })).toMatchObject({
      service_mode: "video",
      part_of_day: "morning",
    });
    expect(SearchProvidersSchema.safeParse({ booking_session: VALID_TOKEN, locality_text: "x y", type: "astrologer" }).success).toBe(false);
    expect(SearchProvidersSchema.safeParse({ booking_session: "short", locality_text: "Kukatpally" }).success).toBe(false);
  });

  it("helpers: part of day, confirm URL, demo date", () => {
    expect([partOfDayOf(9 * 60), partOfDayOf(12 * 60), partOfDayOf(16 * 60 + 59), partOfDayOf(17 * 60)]).toEqual(["morning", "afternoon", "afternoon", "evening"]);
    expect(confirmUrl("p1", "a1")).toBe("/book/p1?appointment=a1");
    expect(dateOf("Saturday 2026-11-14")).toBe("2026-11-14");
  });

  it("routes: public (self-authenticating), no confirm tool exists; CSP + allowlist list ElevenLabs for /find", () => {
    for (const p of ["/api/agents/booking/session", "/api/agents/booking/tools/hold_slot", "/api/agents/booking/demo/get_slots"]) expect(isProtectedPath(p)).toBe(false);
    expect(isProtectedPath("/api/appointments/x/confirm")).toBe(true);
    const tools = readdirSync(path.join(ROOT, "app/api/agents/booking/tools")).sort();
    expect(tools).toEqual(["get_slots", "hold_slot", "search_providers"]);
    expect(existsSync(path.join(ROOT, "app/api/agents/booking/tools/confirm"))).toBe(false);
    for (const dir of ["lib/agents/booking", "app/api/agents/booking"]) {
      for (const file of readdirSync(path.join(ROOT, dir), { recursive: true }) as string[]) {
        if (!file.endsWith(".ts")) continue;
        const src = readFileSync(path.join(ROOT, dir, file), "utf8");
        // The agent can hold, never confirm (D-2).
        expect(src, file).not.toMatch(/confirmHold|booking_confirm\(|booking_attach\(/);
      }
    }
    expect(FAMILY_CSP_EXCEPTIONS["/find"]?.connectSrc).toContain("wss://livekit.rtc.elevenlabs.io");
    expect(allowedOriginsFor("/find")).toContain("https://api.elevenlabs.io");
  });

  it("E-4: the agent guide has the red-flag message, the no-PII rules and no confirm tool", () => {
    const guide = readFileSync(path.join(ROOT, "docs/elevenlabs-booking-agent.md"), "utf8");
    expect(guide).toContain("Please get help now. Call 108 for an ambulance or 112 for emergencies.");
    expect(guide).toMatch(/Never ask for the child's or the parent's name/);
    expect(guide).toMatch(/phone number/);
    expect(guide).toMatch(/date of birth/);
    for (const tool of ["search_providers", "get_slots", "hold_slot", "record_red_flag", "{{booking_session}}", "X-Agent-Secret"]) expect(guide).toContain(tool);
    expect(guide).toMatch(/360/);
    expect(guide).toMatch(/sign in and (tap )?confirm/i);
  });

  it("037: the demo script relays a Google-account refusal instead of failing", async () => {
    const said: string[] = [];
    const callTool: ToolCaller = async (tool) => {
      if (tool === "search_providers") return { status: 200, json: { results: [{ profile_id: "p", name: "Dr X (synthetic)", locality: null, distance_km: null, modes: ["video"] }] } };
      if (tool === "get_slots") return { status: 200, json: { slots: [{ service_id: "s", start: "2026-11-14T04:30:00.000Z", local_time: "Saturday, 14 November, 10:00 am" }] } };
      return { status: 200, json: { held: false, reason: "google_account_required" } };
    };
    const outcome = await runDemoScript({ bookingSession: VALID_TOKEN, today: "Friday 2026-11-13", callTool, say: (_r, t) => void said.push(t) });
    expect(outcome).toEqual({ kind: "refused" });
    expect(said.at(-1)).toBe(DEMO_LINES.googleRequired);
  });

  it("NFR-3: the demo script stops cleanly when nothing is bookable", async () => {
    const said: string[] = [];
    const callTool: ToolCaller = async () => ({ status: 200, json: { results: [] } });
    const outcome = await runDemoScript({ bookingSession: VALID_TOKEN, today: "Friday 2026-11-13", callTool, say: (_r, t) => void said.push(t) });
    expect(outcome).toEqual({ kind: "no_providers" });
    expect(said.at(-1)).toBe(DEMO_LINES.noProviders);
    expect(said.join(" ")).not.toMatch(/name is|phone|date of birth/i);
  });
});

// ---------- database ----------

type Json = Record<string, unknown>;
type Res = { status: number; json: Json; res: Response };

async function call(handler: (req: Request, c: never) => Promise<Response>, req: Request, params?: Record<string, string>): Promise<Res> {
  const res = await handler(req, (params ? ctx(params) : undefined) as never);
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Json, res };
}

/** Applies Set-Cookie headers of a response to the mocked browser cookie jar. */
function keepCookies(res: Response) {
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(";");
    const i = pair.indexOf("=");
    session.cookies.set(pair.slice(0, i), decodeURIComponent(pair.slice(i + 1)));
  }
}

const toolReq = (tool: string, body: unknown, secret: string | null = SECRET) =>
  new Request(`http://localhost/api/agents/booking/tools/${tool}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(secret === null ? {} : { "X-Agent-Secret": secret }) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe.skipIf(!enabled)("booking agent tools (database, route handlers)", { timeout: 180_000 }, () => {
  let sql: Sql;
  let world: ReturnType<typeof bookingWorld>;
  const providers: TestProvider[] = [];
  let main: TestProvider;
  let mainClinic: string;
  let guardianA: { user: TestUser; childId: string };
  let guardianB: { user: TestUser; childId: string };
  const tokens: string[] = [];
  let routes: {
    session: typeof import("@/app/api/agents/booking/session/route");
    search: typeof import("@/app/api/agents/booking/tools/search_providers/route");
    slots: typeof import("@/app/api/agents/booking/tools/get_slots/route");
    hold: typeof import("@/app/api/agents/booking/tools/hold_slot/route");
    demo: typeof import("@/app/api/agents/booking/demo/[tool]/route");
    confirm: typeof import("@/app/api/appointments/[id]/confirm/route");
    paymentOrder: typeof import("@/app/api/appointments/[id]/payment-order/route");
  };
  let online600: string;
  let mainVideo: string;

  // Shamshabad (bundled geocoder table): far from the other suites' synthetic clinics.
  const AREA = "Shamshabad";

  /** A fresh browser: empty cookie jar, then POST /api/agents/booking/session. */
  async function startSession(): Promise<{ token: string; owner: string; res: Res }> {
    session.user = null;
    session.cookies.clear();
    const res = await call(routes.session.POST, new Request("http://localhost/api/agents/booking/session", { method: "POST", headers: { "x-forwarded-for": `10.34.${tokens.length}.1` } }));
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    keepCookies(res.res);
    const token = res.json.booking_session as string;
    tokens.push(token);
    return { token, owner: session.cookies.get("dnm_booking")!, res };
  }

  const tool = (name: "search_providers" | "get_slots" | "hold_slot", body: unknown, secret: string | null = SECRET) => {
    const handler = { search_providers: routes.search, get_slots: routes.slots, hold_slot: routes.hold }[name].POST;
    return call(handler, toolReq(name, body, secret));
  };

  beforeAll(async () => {
    vi.stubEnv("DEMO_MODE", "true");
    vi.stubEnv("ELEVENLABS_TOOL_SECRET", SECRET);
    vi.stubEnv("GOOGLE_MAPS_SERVER_KEY", "");
    vi.stubEnv("SHOW_SYNTHETIC_LISTINGS", "true");
    vi.stubEnv("RAZORPAY_KEY_ID", "");
    sql = postgres(process.env.DATABASE_URL as string, { max: 4, prepare: false, onnotice: () => {} });
    const db = (await import("@/lib/db")).supabaseAdmin();
    world = bookingWorld(sql, db, "t034");
    // 7 bookable speech therapists in Shamshabad (> 5, to check the limit); the first also offers video.
    for (let i = 0; i < 7; i++) {
      const p = await world.provider(`p${i}`);
      await sql`update practice_locations set lat = 17.256, lng = 78.401, locality = ${AREA}, pincode = '501218' where id = ${p.locationId}`;
      providers.push(p);
    }
    main = providers[0];
    mainClinic = await world.service(main, { duration: 30, payment: "free", name: "Speech assessment (synthetic)" });
    mainVideo = await world.service(main, { mode: "video", duration: 30, payment: "free", name: "Video consult (synthetic)" });
    for (const p of providers.slice(1)) await world.service(p, { duration: 30, payment: "free" });
    online600 = await world.service(providers[6], { duration: 30, payment: "online", fee: 600, name: "Online assessment (synthetic)" });
    guardianA = await world.guardian("ga");
    guardianB = await world.guardian("gb");
    routes = {
      session: await import("@/app/api/agents/booking/session/route"),
      search: await import("@/app/api/agents/booking/tools/search_providers/route"),
      slots: await import("@/app/api/agents/booking/tools/get_slots/route"),
      hold: await import("@/app/api/agents/booking/tools/hold_slot/route"),
      demo: await import("@/app/api/agents/booking/demo/[tool]/route"),
      confirm: await import("@/app/api/appointments/[id]/confirm/route"),
      paymentOrder: await import("@/app/api/appointments/[id]/payment-order/route"),
    };
  });

  beforeEach(async () => {
    const { agentSessionLimiter, toolBurstLimiter } = await import("@/lib/agents/booking/rate-limit");
    agentSessionLimiter.reset();
    toolBurstLimiter.reset();
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    if (sql) {
      const { hashAgentToken } = await import("@/lib/agents/booking/session");
      const hashes = tokens.map(hashAgentToken);
      if (hashes.length) {
        await purgeAudit(hashes);
        await sql`delete from booking_agent_sessions where token_hash in ${sql(hashes)}`;
      }
      // 031: payments block appointment deletes; remove this suite's payments first.
      const ids = providers.map((p) => p.profileId);
      if (ids.length) {
        const pays = await sql<{ id: string }[]>`
          select p.id from payments p join appointments a on a.id = p.appointment_id where a.provider_profile_id in ${sql(ids)}`;
        const payIds = pays.map((p) => p.id);
        if (payIds.length) {
          await sql`delete from payment_events where payment_id in ${sql(payIds)}`;
          await sql`delete from outbox_events where aggregate_type = 'payment' and aggregate_id in ${sql(payIds)}`;
          const { purgeTestAudit } = await import("./helpers/audit");
          await purgeTestAudit(sql, (tx) => tx`delete from audit_events where entity = 'payment' and entity_id in ${tx(payIds)}`);
          await sql`delete from payments where id in ${sql(payIds)}`;
        }
      }
    }
    await world?.cleanup();
    await sql?.end({ timeout: 5 });
  });

  async function purgeAudit(hashes: string[]) {
    const { purgeTestAudit } = await import("./helpers/audit");
    await purgeTestAudit(sql, (tx) => tx`delete from audit_events where action = 'booking_agent.hold_created' and details ->> 'session_hash' in ${tx(hashes)}`);
  }

  it("FR-2: session -> 201 { conversation_token, booking_session }, cookies set, only the hash stored", async () => {
    const { token, owner, res } = await startSession();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(res.json).toMatchObject({ demo: true, conversation_token: null, dynamic_variables: { booking_session: token } });
    expect(String(res.json.dynamic_variables && (res.json.dynamic_variables as Json).today)).toMatch(/^[A-Z][a-z]+day \d{4}-\d{2}-\d{2}$/);
    const setCookies = res.res.headers.getSetCookie().join("\n");
    expect(setCookies).toMatch(/dnm_booking_session=.*HttpOnly/i);
    expect(setCookies).toMatch(/dnm_booking=.*HttpOnly/i);
    expect(owner).toBeTruthy();
    const rows = await sql`select * from booking_agent_sessions where token_hash = ${(await import("@/lib/agents/booking/session")).hashAgentToken(token)}`;
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toContain(token);
    expect(rows[0].owner_session_hash).toBe((await import("@/lib/booking/session")).hashBookingSession(owner));
    expect(new Date(rows[0].expires_at).getTime() - new Date(rows[0].created_at).getTime()).toBe(30 * 60_000);
  });

  it("FR-2: 5 sessions per IP per hour, then 429", async () => {
    const req = () => new Request("http://localhost/api/agents/booking/session", { method: "POST", headers: { "x-forwarded-for": "10.34.99.9" } });
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      session.cookies.clear();
      const r = await call(routes.session.POST, req());
      if (r.status === 201) tokens.push(r.json.booking_session as string);
      statuses.push(r.status);
    }
    expect(statuses).toEqual([201, 201, 201, 201, 201, 429]);
  });

  it("live mode: no agent/secret -> 503; agent + secret -> conversation token from ElevenLabs (mocked)", async () => {
    vi.stubEnv("DEMO_MODE", "false");
    try {
      vi.stubEnv("ELEVENLABS_BOOKING_AGENT_ID", "");
      expect((await call(routes.session.POST, new Request("http://localhost/x", { method: "POST" }))).status).toBe(503);
      vi.stubEnv("ELEVENLABS_BOOKING_AGENT_ID", "agent_booking_test");
      vi.stubEnv("ELEVENLABS_TOOL_SECRET", "");
      expect((await call(routes.session.POST, new Request("http://localhost/x", { method: "POST" }))).status).toBe(503);
      vi.stubEnv("ELEVENLABS_TOOL_SECRET", SECRET);
      vi.stubEnv("ELEVENLABS_API_KEY", "test-key");
      const fetchMock = vi.fn(async () => Response.json({ token: "conv-token-synthetic" }));
      vi.stubGlobal("fetch", fetchMock);
      session.cookies.clear();
      const r = await call(routes.session.POST, new Request("http://localhost/x", { method: "POST" }));
      expect(r.status).toBe(201);
      tokens.push(r.json.booking_session as string);
      expect(r.json).toMatchObject({ conversation_token: "conv-token-synthetic", agent_id: "agent_booking_test" });
      expect(r.json.demo).toBeUndefined();
      expect(String(fetchMock.mock.calls[0]?.[0 as never])).toContain("agent_id=agent_booking_test");
      // The DEMO_MODE tool route does not exist outside DEMO_MODE.
      const demo = await call(routes.demo.POST, toolReq("search_providers", {}, null), { tool: "search_providers" });
      expect(demo.status).toBe(404);
    } finally {
      vi.unstubAllGlobals();
      vi.stubEnv("DEMO_MODE", "true");
      vi.stubEnv("ELEVENLABS_TOOL_SECRET", SECRET);
    }
  });

  it("FR-3 / D-4: secret missing or wrong -> 401; unknown, expired or ended session -> 401", async () => {
    const { token } = await startSession();
    const body = { booking_session: token, locality_text: AREA };
    expect((await tool("search_providers", body, null)).status).toBe(401);
    expect((await tool("search_providers", body, "wrong-secret")).status).toBe(401);
    expect((await tool("search_providers", body, `${SECRET}x`)).status).toBe(401);
    vi.stubEnv("ELEVENLABS_TOOL_SECRET", "");
    expect((await tool("search_providers", body, "")).status).toBe(401);
    vi.stubEnv("ELEVENLABS_TOOL_SECRET", SECRET);
    expect((await tool("search_providers", body)).status).toBe(200);

    const unknown = await tool("search_providers", { ...body, booking_session: VALID_TOKEN });
    expect(unknown.status).toBe(401);
    expect(unknown.json.error).toBe("Invalid or expired booking session");
    expect((await tool("search_providers", { locality_text: AREA })).status).toBe(401);

    const { hashAgentToken } = await import("@/lib/agents/booking/session");
    await sql`update booking_agent_sessions set created_at = now() - interval '31 minutes', expires_at = now() - interval '1 minute' where token_hash = ${hashAgentToken(token)}`;
    expect((await tool("search_providers", body)).status).toBe(401);

    const second = await startSession();
    expect((await call(routes.session.DELETE, new Request("http://localhost/x", { method: "DELETE" }))).status).toBe(200);
    expect((await tool("search_providers", { booking_session: second.token, locality_text: AREA })).status).toBe(401);
  });

  it("NFR-2 / E-4: payload keys outside the schema -> 400 (child_name, phone); bad JSON -> 400", async () => {
    const { token } = await startSession();
    const withName = await tool("search_providers", { booking_session: token, locality_text: AREA, child_name: "Synthetic Child" });
    expect(withName.status).toBe(400);
    expect(JSON.stringify(withName.json)).toMatch(/child_name/);
    expect((await tool("get_slots", { booking_session: token, profile_id: main.profileId, service_mode: "in_clinic", date_from: "2026-11-14", phone: "x" })).status).toBe(400);
    expect((await tool("hold_slot", { booking_session: token, profile_id: main.profileId, service_id: mainClinic, start: futureSlot(4).toISOString(), dob: "2021" })).status).toBe(400);
    expect((await tool("search_providers", "not json")).status).toBe(400);
    expect((await tool("search_providers", [token])).status).toBe(400);
  });

  it("FR-3: the 21st tool call in a session -> 429", async () => {
    const { token } = await startSession();
    const statuses: number[] = [];
    for (let i = 0; i < MAX_TOOL_CALLS + 1; i++) {
      // Invalid payloads still use the budget.
      statuses.push((await tool("get_slots", { booking_session: token, profile_id: "nope", service_mode: "video", date_from: "2026-11-14" })).status);
    }
    expect(statuses.slice(0, MAX_TOOL_CALLS).every((s) => s === 400)).toBe(true);
    expect(statuses[MAX_TOOL_CALLS]).toBe(429);
    expect((await tool("search_providers", { booking_session: token, locality_text: AREA })).status).toBe(429);
  });

  it("search_providers: geocoded server-side, top 5 bookable results with the FR-3 fields", async () => {
    const { token } = await startSession();
    const r = await tool("search_providers", { booking_session: token, locality_text: AREA, type: "speech therapist", mode: "in_clinic" });
    expect(r.status).toBe(200);
    const results = r.json.results as Json[];
    expect(results).toHaveLength(MAX_PROVIDERS);
    for (const p of results) {
      expect(Object.keys(p).sort()).toEqual(["distance_km", "languages", "locality", "modes", "name", "profile_id", "type"]);
      expect(p.type).toBe("speech_language_pathologist");
      expect(p.locality).toBe(AREA);
      expect(p.distance_km).toBeLessThan(1);
    }
    const ours = new Set(providers.map((p) => p.profileId));
    expect(results.every((p) => ours.has(p.profile_id as string))).toBe(true);

    const video = await tool("search_providers", { booking_session: token, locality_text: AREA, mode: "video" });
    expect((video.json.results as Json[]).map((p) => p.profile_id)).toContain(main.profileId);
    expect((video.json.results as Json[]).filter((p) => ours.has(p.profile_id as string)).map((p) => p.profile_id)).toEqual([main.profileId]);

    const nowhere = await tool("search_providers", { booking_session: token, locality_text: "Atlantis Lagoon" });
    expect(nowhere.status).toBe(200);
    expect(nowhere.json.results).toEqual([]);
    expect(String(nowhere.json.message)).toMatch(/could not find/);
  });

  it("get_slots: max 6 slots, part_of_day respected, unknown provider 404", async () => {
    const { token } = await startSession();
    const { todayIn, addDays, utcToWall } = await import("@/lib/booking/time");
    const from = addDays(todayIn("Asia/Kolkata"), 1);
    const all = await tool("get_slots", { booking_session: token, profile_id: main.profileId, service_mode: "in_clinic", date_from: from });
    expect(all.status).toBe(200);
    const slots = all.json.slots as Json[];
    expect(slots).toHaveLength(MAX_SLOTS);
    expect(slots[0]).toMatchObject({ service_id: mainClinic, service_name: "Speech assessment (synthetic)", time_zone: "Asia/Kolkata" });
    expect(String(slots[0].local_time)).toMatch(/^[A-Z][a-z]+day, \d{1,2} [A-Z][a-z]+, \d{1,2}:\d{2} (am|pm)$/i);

    const evening = await tool("get_slots", { booking_session: token, profile_id: main.profileId, service_mode: "in_clinic", date_from: from, part_of_day: "evening" });
    const eveningSlots = evening.json.slots as Json[];
    expect(eveningSlots.length).toBeGreaterThan(0);
    for (const s of eveningSlots) expect(utcToWall(Date.parse(s.start as string), "Asia/Kolkata").minutes).toBeGreaterThanOrEqual(17 * 60);

    const video = await tool("get_slots", { booking_session: token, profile_id: main.profileId, service_mode: "video", date_from: from });
    expect((video.json.slots as Json[]).every((s) => s.service_name === "Video consult (synthetic)")).toBe(true);
    const none = await tool("get_slots", { booking_session: token, profile_id: providers[1].profileId, service_mode: "video", date_from: from });
    expect(none.json.slots).toEqual([]);

    expect((await tool("get_slots", { booking_session: token, profile_id: crypto.randomUUID(), service_mode: "video", date_from: from })).status).toBe(404);
  });

  it("E-1 / FR-5: hold_slot -> held, owned by the browser session (sha256 of the cookie), audit actor ai with the session hash only", async () => {
    const { token, owner } = await startSession();
    const start = futureSlot(5);
    const r = await tool("hold_slot", { booking_session: token, profile_id: main.profileId, service_id: mainClinic, start: start.toISOString() });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json).toMatchObject({ held: true, provider_name: expect.any(String), start: start.toISOString() });
    const id = r.json.appointment_id as string;
    expect(r.json.confirm_url).toBe(`/book/${main.profileId}?appointment=${id}`);
    expect(Date.parse(r.json.expires_at as string) - Date.now()).toBeGreaterThan(9 * 60_000);
    expect(String(r.json.message)).toMatch(/cannot confirm/);

    const { hashBookingSession } = await import("@/lib/booking/session");
    const { hashAgentToken } = await import("@/lib/agents/booking/session");
    const [row] = await sql`select status, hold_owner_session, hold_owner_user_id, child_id, guardian_user_id from appointments where id = ${id}`;
    expect(row).toMatchObject({ status: "held", hold_owner_session: hashBookingSession(owner), hold_owner_user_id: null, child_id: null, guardian_user_id: null });
    const [agentSession] = await sql`select hold_appointment_id from booking_agent_sessions where token_hash = ${hashAgentToken(token)}`;
    expect(agentSession.hold_appointment_id).toBe(id);

    const audits = await sql`select actor, actor_role, actor_user_id, details, entity, entity_id from audit_events where action = 'booking_agent.hold_created' and entity_id = ${id}`;
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actor: "ai", actor_role: "ai", actor_user_id: null, entity: "appointment" });
    expect(audits[0].details).toEqual({ session_hash: hashAgentToken(token) });

    // FR-4: the widget (same browser) sees the hold; another browser does not.
    const status = await call(routes.session.GET, new Request("http://localhost/api/agents/booking/session"));
    expect(status.json.hold).toMatchObject({ appointment_id: id, profile_id: main.profileId, confirm_url: `/book/${main.profileId}?appointment=${id}` });
    const saved = new Map(session.cookies);
    session.cookies.clear();
    expect((await call(routes.session.GET, new Request("http://localhost/api/agents/booking/session"))).status).toBe(404);
    session.cookies.set("dnm_booking_session", VALID_TOKEN);
    expect((await call(routes.session.GET, new Request("http://localhost/api/agents/booking/session"))).status).toBe(404);
    session.cookies.clear();
    for (const [k, v] of saved) session.cookies.set(k, v);
  });

  it("FR-3: a second hold in the session releases the first (one hold per session)", async () => {
    const { token } = await startSession();
    const first = await tool("hold_slot", { booking_session: token, profile_id: main.profileId, service_id: mainClinic, start: futureSlot(20).toISOString() });
    const second = await tool("hold_slot", { booking_session: token, profile_id: main.profileId, service_id: mainClinic, start: futureSlot(20, 30, 2).toISOString() });
    expect(first.json.held).toBe(true);
    expect(second.json.held).toBe(true);
    const rows = await sql<{ id: string; status: string; cancel_reason: string | null }[]>`
      select id, status, cancel_reason from appointments where id in ${sql([first.json.appointment_id as string, second.json.appointment_id as string])}`;
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId[first.json.appointment_id as string]).toMatchObject({ status: "cancelled", cancel_reason: "hold_released" });
    expect(byId[second.json.appointment_id as string].status).toBe("held");
  });

  it("FR-3: slot_taken -> { held: false, reason: 'slot_taken' }; mismatched provider/service -> 404", async () => {
    const start = futureSlot(30);
    const { holdSlot } = await import("@/lib/booking/store");
    await holdSlot({ service_id: mainClinic, start: start.toISOString(), idempotency_key: "k-034-someone-else" }, { sessionHash: sessionHash() });
    const { token } = await startSession();
    const r = await tool("hold_slot", { booking_session: token, profile_id: main.profileId, service_id: mainClinic, start: start.toISOString() });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ held: false, reason: "slot_taken" });
    const wrong = await tool("hold_slot", { booking_session: token, profile_id: providers[1].profileId, service_id: mainClinic, start: futureSlot(31).toISOString() });
    expect(wrong.status).toBe(404);
    const offGrid = await tool("hold_slot", { booking_session: token, profile_id: main.profileId, service_id: mainClinic, start: new Date(futureSlot(32).getTime() + 7 * 60_000).toISOString() });
    expect(offGrid.json).toMatchObject({ held: false, reason: "slot_unavailable" });
  });

  it("037: a video hold is refused for the agent (no Google identity) -> 200 { held: false, reason: 'google_account_required' }, nothing held", async () => {
    const { token } = await startSession();
    const start = futureSlot(70);
    const r = await tool("hold_slot", { booking_session: token, profile_id: main.profileId, service_id: mainVideo, start: start.toISOString() });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ held: false, reason: "google_account_required", booking_url: `/book/${main.profileId}` });
    expect(String(r.json.message)).toMatch(/Google account/);
    expect(String(r.json.message)).toMatch(/in-clinic/);
    const rows = await sql`select id from appointments where provider_profile_id = ${main.profileId} and lower(slot) = ${start}`;
    expect(rows).toHaveLength(0);
    const { hashAgentToken } = await import("@/lib/agents/booking/session");
    const [agentSession] = await sql`select hold_appointment_id from booking_agent_sessions where token_hash = ${hashAgentToken(token)}`;
    expect(agentSession.hold_appointment_id).toBeNull();
    const video = await tool("get_slots", { booking_session: token, profile_id: main.profileId, service_mode: "video", date_from: (await import("@/lib/booking/time")).todayIn("Asia/Kolkata") });
    expect(String(video.json.message)).toMatch(/sign in with Google/);
  });

  it("E-2 / E-3: confirm needs a signed-in guardian (401); another browser's cookie -> 404; the holding browser -> confirmed", async () => {
    const { token, owner } = await startSession();
    const r = await tool("hold_slot", { booking_session: token, profile_id: main.profileId, service_id: mainClinic, start: futureSlot(40).toISOString() });
    const id = r.json.appointment_id as string;
    const confirm = () => call(routes.confirm.POST, post(`http://localhost/api/appointments/${id}/confirm`, { child_id: guardianA.childId }), { id });

    session.user = null;
    expect((await confirm()).status).toBe(401);

    // Another browser (other cookie), even signed in as a guardian.
    session.cookies.clear();
    session.cookies.set("dnm_booking", "B".repeat(43));
    session.user = { id: guardianB.user.id };
    const other = await call(routes.confirm.POST, post(`http://localhost/api/appointments/${id}/confirm`, { child_id: guardianB.childId }), { id });
    expect(other.status).toBe(404);

    session.cookies.clear();
    session.cookies.set("dnm_booking", owner);
    session.user = { id: guardianA.user.id };
    const ok = await confirm();
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect((ok.json.appointment as Json).status).toBe("confirmed");
    session.user = null;
  });

  it("031: an agent hold on an online-payment service -> confirm moves it to pending_payment and the guardian gets the payment step", async () => {
    const { token, owner } = await startSession();
    const { todayIn, addDays } = await import("@/lib/booking/time");
    const listed = await tool("get_slots", { booking_session: token, profile_id: providers[6].profileId, service_mode: "in_clinic", date_from: addDays(todayIn("Asia/Kolkata"), 1) });
    expect((listed.json.slots as Json[]).find((x) => x.service_id === online600)).toMatchObject({ payment_mode: "online", fee_inr: 600 });

    const r = await tool("hold_slot", { booking_session: token, profile_id: providers[6].profileId, service_id: online600, start: futureSlot(60).toISOString() });
    expect(r.json).toMatchObject({ held: true, payment_mode: "online", fee_inr: 600 });
    expect(String(r.json.message)).toMatch(/pays the fee of 600 rupees online/);
    const id = r.json.appointment_id as string;
    const status = await call(routes.session.GET, new Request("http://localhost/api/agents/booking/session"));
    expect(status.json.hold).toMatchObject({ appointment_id: id, payment_mode: "online", fee_inr: 600 });

    session.cookies.set("dnm_booking", owner);
    session.user = { id: guardianA.user.id };
    const confirmed = await call(routes.confirm.POST, post(`http://localhost/api/appointments/${id}/confirm`, { child_id: guardianA.childId }), { id });
    expect(confirmed.status, JSON.stringify(confirmed.json)).toBe(200);
    expect((confirmed.json.appointment as Json).status).toBe("pending_payment");
    // The 030/031 page then opens /book/<profile>/pay/<appointment>, which asks this route for the order.
    const order = await call(routes.paymentOrder.POST, post(`http://localhost/api/appointments/${id}/payment-order`, {}), { id });
    expect(order.status, JSON.stringify(order.json)).toBe(200);
    expect(order.json).toMatchObject({ amount_paise: 60000, currency: "INR" });
    session.user = null;
  });

  it("NFR-3: the DEMO_MODE script holds a slot through the cookie-bound demo route (same handlers)", async () => {
    const { token, res } = await startSession();
    // Wrong cookie -> 401, even with a valid token in the body.
    const saved = session.cookies.get("dnm_booking_session")!;
    session.cookies.set("dnm_booking_session", VALID_TOKEN);
    const denied = await call(routes.demo.POST, toolReq("search_providers", { booking_session: token, locality_text: AREA }, null), { tool: "search_providers" });
    expect(denied.status).toBe(401);
    session.cookies.set("dnm_booking_session", saved);
    expect((await call(routes.demo.POST, toolReq("confirm", { booking_session: token }, null), { tool: "confirm" })).status).toBe(404);

    const lines: string[] = [];
    const callTool: ToolCaller = async (name, args) => {
      // The demo searches Banjara Hills; point it at this suite's area instead.
      const body = name === "search_providers" ? { ...args, locality_text: AREA } : args;
      const r = await call(routes.demo.POST, toolReq(name, body, null), { tool: name });
      return { status: r.status, json: r.json };
    };
    const outcome = await runDemoScript({
      bookingSession: token,
      today: String((res.json.dynamic_variables as Json).today),
      callTool,
      say: (_role, text) => void lines.push(text),
    });
    expect(outcome.kind, lines.join("\n")).toBe("held");
    const id = (outcome as { appointment_id: string }).appointment_id;
    const [row] = await sql`select status from appointments where id = ${id}`;
    expect(row.status).toBe("held");
    expect(lines.at(-1)).toMatch(/holding .* for 10 minutes/);
    expect(lines.join(" ")).toMatch(/Sign in and confirm/);
  });

  it("NFR-1: tool calls answer well under 1.5 s p95 locally", async () => {
    const { todayIn, addDays } = await import("@/lib/booking/time");
    const from = addDays(todayIn("Asia/Kolkata"), 1);
    const timings: Record<string, number[]> = { search_providers: [], get_slots: [], hold_slot: [] };
    for (let round = 0; round < 2; round++) {
      const { token } = await startSession();
      for (let i = 0; i < 6; i++) {
        let t0 = performance.now();
        expect((await tool("search_providers", { booking_session: token, locality_text: AREA })).status).toBe(200);
        timings.search_providers.push(performance.now() - t0);
        t0 = performance.now();
        expect((await tool("get_slots", { booking_session: token, profile_id: main.profileId, service_mode: "in_clinic", date_from: from })).status).toBe(200);
        timings.get_slots.push(performance.now() - t0);
        t0 = performance.now();
        const h = await tool("hold_slot", { booking_session: token, profile_id: providers[2 + round].profileId, service_id: (await sql<{ id: string }[]>`select id from services where provider_profile_id = ${providers[2 + round].profileId}`)[0].id, start: futureSlot(50, 30, i).toISOString() });
        timings.hold_slot.push(performance.now() - t0);
        expect(h.json.held, JSON.stringify(h.json)).toBe(true);
      }
    }
    const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * 0.95) - 1];
    const summary = Object.fromEntries(Object.entries(timings).map(([k, v]) => [k, Math.round(p95(v))]));
    console.info(`[034 NFR-1] p95 ms ${JSON.stringify(summary)}`);
    for (const ms of Object.values(summary)) expect(ms).toBeLessThan(1500);
  });
});
