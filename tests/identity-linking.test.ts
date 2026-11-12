// Ticket 019 FR-1/FR-3/FR-9/NFR-1/NFR-4: OAuth callback, safe identity linking (never merging accounts),
// unlinking rules, OTP send rate limits (mocked clock) and phone redaction. Unit blocks mock Supabase; the
// database blocks use the configured local Supabase with synthetic users (skipped without DATABASE_URL).
import { randomUUID } from "node:crypto";
import { loadEnvConfig } from "@next/env";
import postgres, { type Sql } from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

loadEnvConfig(process.cwd(), false, { info: () => {}, error: () => {} });
const enabled = Boolean(process.env.DATABASE_URL) && process.env.SKIP_DB_TESTS !== "1";

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    getAll: () => [...jar].map(([name, value]) => ({ name, value })),
    set: (name: string, value: string) => void jar.set(name, value),
  }),
  headers: async () => ({ get: () => null }),
}));

// Each mock delegates to the real module unless the unit test configures it.
const state = vi.hoisted(() => ({
  session: null as null | Record<string, unknown>,
  role: "guardian" as string,
  routeClient: null as null | Record<string, unknown>,
  owner: undefined as undefined | string | null,
  backend: null as null | StubBackend,
  rateLimit: null as null | string,
}));

vi.mock("@/lib/authz", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/authz")>();
  return {
    ...actual,
    requireGuardian: vi.fn(async () => {
      if (!state.session) return actual.requireGuardian();
      return { user: state.session, profile: { id: state.session.id, role: "guardian" } };
    }),
  };
});
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getUserRole: vi.fn(async (id: string) => (state.routeClient ? state.role : actual.getUserRole(id))) };
});
vi.mock("@/lib/supabase-server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/supabase-server")>();
  return { ...actual, supabaseRouteClient: vi.fn(async () => state.routeClient ?? actual.supabaseRouteClient()) };
});
vi.mock("@/lib/family/phone-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/family/phone-auth")>();
  return {
    ...actual,
    findUserIdByPhone: vi.fn(async (phone: string) => (state.owner !== undefined ? state.owner : actual.findUserIdByPhone(phone))),
    phoneAuthFor: vi.fn((phone: string) => (state.backend ?? actual.phoneAuthFor(phone)) as never),
  };
});
vi.mock("@/lib/family/otp-rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/family/otp-rate-limit")>();
  return {
    ...actual,
    recordOtpSend: vi.fn(async (...args: Parameters<typeof actual.recordOtpSend>) =>
      state.rateLimit ?? actual.recordOtpSend(...args),
    ),
  };
});
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));

import { GET as callback } from "@/app/auth/callback/route";
import { DELETE as unlinkRoute } from "@/app/api/family/identities/route";
import { POST as addPhone } from "@/app/api/family/identities/phone/route";
import { POST as verifyPhone } from "@/app/api/family/identities/phone/verify/route";
import { POST as sendCode } from "@/app/api/auth/phone/send/route";
import { POST as verifyCode } from "@/app/api/auth/phone/verify/route";
import { audit } from "@/lib/audit";
import { recordOtpSend } from "@/lib/family/otp-rate-limit";
import { canUnlink, signInMethods } from "@/lib/family/identities";
import { maskPhone, normalizeIndianMobile, redactPhones } from "@/lib/family/phone";
import { supabasePhoneAuth, type SendResult, type VerifyResult } from "@/lib/family/phone-auth";

const json = (url: string, body: unknown, method = "POST", headers: Record<string, string> = {}) =>
  new Request(`http://localhost${url}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

const GUARDIAN_ID = "00000000-0000-4000-8000-0000000000aa";
const googleIdentity = { provider: "google", identity_id: "g1", identity_data: { email: "asha.parent@example.com" } };
const phoneIdentity = { provider: "phone", identity_id: "p1", identity_data: {} };

type StubBackend = ReturnType<typeof stubBackend>;

function stubBackend() {
  return {
    kind: "demo",
    sendSignInCode: vi.fn(async (): Promise<SendResult> => ({ ok: true })),
    verifySignInCode: vi.fn(async (): Promise<VerifyResult> => ({ ok: true, userId: GUARDIAN_ID })),
    sendPhoneChangeCode: vi.fn(async (): Promise<SendResult> => ({ ok: true })),
    verifyPhoneChangeCode: vi.fn(async (): Promise<VerifyResult> => ({ ok: true, userId: GUARDIAN_ID })),
  };
}

function resetState() {
  state.session = null;
  state.role = "guardian";
  state.routeClient = null;
  state.owner = undefined;
  state.backend = null;
  state.rateLimit = null;
  jar.clear();
  vi.mocked(audit).mockClear();
  vi.mocked(recordOtpSend).mockClear();
}

describe("phone helpers (FR-1, FR-8, NFR-4)", () => {
  it("accepts only 10-digit Indian mobiles starting 6-9", () => {
    expect(normalizeIndianMobile("9000000003")).toBe("919000000003");
    expect(normalizeIndianMobile("+91 90000-00003")).toBe("919000000003");
    for (const bad of ["12345", "5000000003", "90000000031", "abc", "", "+449000000003"]) {
      expect(normalizeIndianMobile(bad), bad).toBeNull();
    }
  });

  it("masks and redacts", () => {
    expect(maskPhone("919000001234")).toBe("+91 ••••••1234");
    expect(redactPhones("send to +919000000003 failed (919000000003)")).not.toMatch(/9000000003/);
  });
});

describe("OAuth callback (FR-3, FR-9)", () => {
  beforeEach(resetState);

  function client(user: Record<string, unknown> | null, error: unknown = null) {
    const exchangeCodeForSession = vi.fn(async () => ({ data: { user }, error }));
    state.routeClient = { auth: { exchangeCodeForSession } };
    return exchangeCodeForSession;
  }
  const go = async (query: string) => {
    const res = await callback(new Request(`http://localhost:3000/auth/callback?${query}`));
    return { status: res.status, location: res.headers.get("location")!.replace("http://localhost:3000", "") };
  };

  it("a Google account owned by another user: FR-9 notice, no session exchange, no merge", async () => {
    const exchange = client(null);
    const result = await go("flow=link&error=server_error&error_code=identity_already_exists&error_description=Identity+is+already+linked");
    expect(result.location).toBe("/family/settings?error=google_in_use");
    expect(exchange).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("sign-in errors go back to the family sign-in page", async () => {
    client(null);
    expect((await go("error=access_denied")).location).toBe("/family/login?error=oauth");
    expect((await go("")).location).toBe("/family/login?error=oauth");
    client(null, { code: "bad_code_verifier" });
    expect((await go("code=abc")).location).toBe("/family/login?error=oauth");
  });

  it.each([
    ["guardian", "/family", "/family"],
    ["guardian", "/dashboard", "/family"],
    ["guardian", "//evil.com", "/family"],
    ["guardian", "https://evil.com", "/family"],
    ["guardian", "/\\evil", "/family"],
    ["guardian", "/family/settings", "/family/settings"],
    ["provider", "/family", "/dashboard"],
    ["platform_admin", "/family", "/admin"],
  ])("%s with next=%s lands on %s", async (role, next, expected) => {
    const exchange = client({ id: GUARDIAN_ID, identities: [googleIdentity] });
    state.role = role;
    const { status, location } = await go(`code=abc&next=${encodeURIComponent(next)}`);
    expect(exchange).toHaveBeenCalledWith("abc");
    expect(status).toBe(307);
    expect(location).toBe(expected);
  });

  it("Connect Google success audits identity_linked with the provider only", async () => {
    client({ id: GUARDIAN_ID, identities: [phoneIdentity, googleIdentity] });
    expect((await go("flow=link&code=abc")).location).toBe("/family/settings?linked=google");
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "guardian.identity_linked", details: { provider: "google" } }));
  });
});

describe("adding a phone never merges accounts (FR-9)", () => {
  beforeEach(() => {
    resetState();
    state.session = { id: GUARDIAN_ID, phone: "919000000001", phone_confirmed_at: "2026-11-12T00:00:00Z", identities: [phoneIdentity] };
    state.backend = stubBackend();
    state.rateLimit = "ok";
  });

  it("a number owned by another account -> 409 FR-9 message; nothing sent or changed", async () => {
    state.owner = "00000000-0000-4000-8000-0000000000bb";
    const send = await addPhone(json("/api/family/identities/phone", { phone: "9000000002" }));
    expect(send.status).toBe(409);
    expect(await send.json()).toEqual({ error: "This number is already linked to another account." });
    const verify = await verifyPhone(json("/api/family/identities/phone/verify", { phone: "9000000002", code: "123456" }));
    expect(verify.status).toBe(409);
    expect(await verify.json()).toEqual({ error: "This number is already linked to another account." });
    expect(state.backend!.sendPhoneChangeCode).not.toHaveBeenCalled();
    expect(state.backend!.verifyPhoneChangeCode).not.toHaveBeenCalled();
    expect(recordOtpSend).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("Supabase reporting the number in use maps to the same message", async () => {
    state.owner = null;
    state.backend!.sendPhoneChangeCode.mockResolvedValueOnce({ ok: false, reason: "phone_in_use" });
    const res = await addPhone(json("/api/family/identities/phone", { phone: "9000000004" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "This number is already linked to another account." });
  });

  it("a free number is linked to the signed-in user only; audit stores the last 4 digits only", async () => {
    state.owner = null;
    expect((await addPhone(json("/api/family/identities/phone", { phone: "9000000004" }))).status).toBe(200);
    const res = await verifyPhone(json("/api/family/identities/phone/verify", { phone: "9000000004", code: "123456" }));
    expect(res.status).toBe(200);
    expect(state.backend!.verifyPhoneChangeCode).toHaveBeenCalledWith(GUARDIAN_ID, "919000000004", "123456");
    const event = vi.mocked(audit).mock.calls[0][0];
    expect(event).toMatchObject({ action: "guardian.identity_linked", details: { provider: "phone", phone_last4: "0004" } });
    expect(JSON.stringify(event)).not.toMatch(/9000000004/);
  });

  it("a wrong code gives the FR-1 message", async () => {
    state.owner = null;
    state.backend!.verifyPhoneChangeCode.mockResolvedValueOnce({ ok: false, reason: "invalid_code" });
    const res = await verifyPhone(json("/api/family/identities/phone/verify", { phone: "9000000004", code: "000000" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "That code is not correct or has expired." });
  });

  it("the Supabase backend maps phone_exists / otp_expired", async () => {
    const backend = supabasePhoneAuth(async () =>
      ({
        auth: {
          updateUser: async () => ({ error: { message: "Phone already registered +919000000002", code: "phone_exists", status: 422 } }),
          verifyOtp: async () => ({ data: { user: null }, error: { message: "Token has expired or is invalid", code: "otp_expired", status: 403 } }),
        },
      }) as never,
    );
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await backend.sendPhoneChangeCode(GUARDIAN_ID, "919000000002")).toEqual({ ok: false, reason: "phone_in_use" });
    expect(await backend.verifySignInCode("919000000002", "000000")).toEqual({ ok: false, reason: "invalid_code" });
    expect(JSON.stringify(errors.mock.calls)).not.toMatch(/9000000002/);
    errors.mockRestore();
  });
});

describe("unlinking (FR-9)", () => {
  beforeEach(resetState);

  function withClient(identities: unknown[]) {
    const unlinkIdentity = vi.fn(async () => ({ data: {}, error: null }));
    state.routeClient = { auth: { getUserIdentities: async () => ({ data: { identities }, error: null }), unlinkIdentity } };
    return unlinkIdentity;
  }

  it("the only method cannot be removed", async () => {
    state.session = { id: GUARDIAN_ID, phone: "919000000001", phone_confirmed_at: "2026-11-12T00:00:00Z", identities: [phoneIdentity] };
    const unlink = withClient([phoneIdentity]);
    const res = await unlinkRoute(json("/api/family/identities", { provider: "phone" }, "DELETE"));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Add another sign-in method first" });
    expect(unlink).not.toHaveBeenCalled();
    expect(canUnlink(signInMethods(state.session as never), "phone")).toBe(false);
  });

  it("with Google and phone, either can be removed (audited)", async () => {
    state.session = {
      id: GUARDIAN_ID,
      phone: "919000000001",
      phone_confirmed_at: "2026-11-12T00:00:00Z",
      identities: [phoneIdentity, googleIdentity],
    };
    expect(signInMethods(state.session as never)).toEqual({ google: { email: "asha.parent@example.com" }, phone: "919000000001" });
    const unlink = withClient([phoneIdentity, googleIdentity]);
    const res = await unlinkRoute(json("/api/family/identities", { provider: "google" }, "DELETE"));
    expect(res.status).toBe(200);
    expect(unlink).toHaveBeenCalledWith(googleIdentity);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "guardian.identity_unlinked", details: { provider: "google" } }));
  });
});

describe.skipIf(!enabled)("OTP sends are rate limited (NFR-1, mocked clock)", { timeout: 60_000 }, () => {
  let sql: Sql;
  const base = new Date(Date.UTC(2031, 0, 1) + Math.floor(Math.random() * 300) * 86_400_000);

  beforeAll(() => {
    sql = postgres(process.env.DATABASE_URL as string, { max: 2, prepare: false, onnotice: () => {} });
  });
  beforeEach(() => {
    resetState();
    process.env.DEMO_MODE = "true";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(base);
  });
  afterEach(() => vi.useRealTimers());
  afterAll(async () => {
    await sql`delete from otp_send_attempts where created_at >= ${base.toISOString()}::timestamptz - interval '1 day'`;
    await sql.end({ timeout: 5 });
  });

  const send = (phone: string, ip: string) => sendCode(json("/api/auth/phone/send", { phone }, "POST", { "x-forwarded-for": `${ip}, 10.0.0.1` }));

  it("429 after 5 sends per number per hour; allowed again an hour later", async () => {
    const ip = `198.51.100.${Math.floor(Math.random() * 250)}-${randomUUID()}`;
    for (let i = 0; i < 5; i++) expect((await send("9000000005", ip)).status, `send ${i + 1}`).toBe(200);
    const limited = await send("9000000005", `${ip}-other`);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "Too many codes requested. Try again later." });
    vi.setSystemTime(new Date(base.getTime() + 60 * 60_000 + 1000));
    expect((await send("9000000005", ip)).status).toBe(200);
  });

  it("429 after 20 sends per IP per hour across numbers", async () => {
    vi.setSystemTime(new Date(base.getTime() + 3 * 60 * 60_000));
    const ip = `203.0.113.7-${randomUUID()}`;
    const phones = ["9000000001", "9000000002", "9000000003", "9000000004", "9000000005"];
    for (let i = 0; i < 20; i++) expect((await send(phones[i % 5], ip)).status, `send ${i + 1}`).toBe(200);
    expect((await send("9000000001", ip)).status).toBe(429);
  });
});

describe.skipIf(!enabled)("phone sign-in and linking against Supabase (FR-1, FR-9, FR-10, NFR-4)", { timeout: 60_000 }, () => {
  const PHONE = "919000000005";
  let sql: Sql;
  let db: ReturnType<typeof import("@/lib/db").supabaseAdmin>;
  const users: string[] = [];
  let parked: { id: string; phone_confirmed_at: Date | null } | null = null;

  beforeAll(async () => {
    sql = postgres(process.env.DATABASE_URL as string, { max: 2, prepare: false, onnotice: () => {} });
    db = (await import("@/lib/db")).supabaseAdmin();
    // Park whoever holds the test number (synthetic local data) and give it back afterwards.
    [parked = null] = await sql<{ id: string; phone_confirmed_at: Date | null }[]>`
      select id, phone_confirmed_at from auth.users where phone = ${PHONE}`;
    if (parked) await sql`update auth.users set phone = null where id = ${parked.id}`;
  });

  beforeEach(() => {
    resetState();
    process.env.DEMO_MODE = "true";
    state.rateLimit = "ok";
  });

  afterAll(async () => {
    for (const id of users) await db.auth.admin.deleteUser(id);
    if (parked) await sql`update auth.users set phone = ${PHONE}, phone_confirmed_at = ${parked.phone_confirmed_at} where id = ${parked.id}`;
    await sql.end({ timeout: 5 });
  });

  it("E-1: a new number signs up as a guardian with a verified phone and a session cookie", async () => {
    const wrong = await verifyCode(json("/api/auth/phone/verify", { phone: "9000000005", code: "000000" }));
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toEqual({ error: "That code is not correct or has expired." });

    const res = await verifyCode(json("/api/auth/phone/verify", { phone: "9000000005", code: "123456", next: "//evil.com" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ redirect: "/family" });
    expect([...jar.keys()].some((name) => name.startsWith("sb-"))).toBe(true);
    const [row] = await sql<{ id: string; role: string; phone_verified_at: Date | null }[]>`
      select p.id, p.role, p.phone_verified_at from auth.users u join user_profiles p on p.id = u.id where u.phone = ${PHONE}`;
    users.push(row.id);
    expect(row.role).toBe("guardian");
    expect(row.phone_verified_at).not.toBeNull();
  });

  it("E-3: adding a number that belongs to another account changes neither account", async () => {
    const { data } = await db.auth.admin.createUser({ email: `t019-link-${randomUUID().slice(0, 8)}@example.com`, email_confirm: true });
    users.push(data.user!.id);
    const before = await sql`select id, phone from auth.users where id in ${sql(users)} order by id`;
    state.session = { id: data.user!.id, identities: [] };

    const res = await addPhone(json("/api/family/identities/phone", { phone: "9000000005" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "This number is already linked to another account." });
    const verify = await verifyPhone(json("/api/family/identities/phone/verify", { phone: "9000000005", code: "123456" }));
    expect(verify.status).toBe(409);
    expect(await sql`select id, phone from auth.users where id in ${sql(users)} order by id`).toEqual(before);

    // Once the number is free, the demo backend confirms it on the signed-in user's own account.
    await db.auth.admin.deleteUser(users[0]);
    users.shift();
    expect((await addPhone(json("/api/family/identities/phone", { phone: "9000000005" }))).status).toBe(200);
    expect((await verifyPhone(json("/api/family/identities/phone/verify", { phone: "9000000005", code: "123456" }))).status).toBe(200);
    const [linked] = await sql<{ phone: string; phone_verified_at: Date | null }[]>`
      select u.phone, p.phone_verified_at from auth.users u join user_profiles p on p.id = u.id where u.id = ${data.user!.id}`;
    expect(linked.phone).toBe(PHONE);
    expect(linked.phone_verified_at).not.toBeNull();
  });

  it("NFR-4: failed real-SMS sends never log the number", async () => {
    process.env.DEMO_MODE = "false";
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await sendCode(json("/api/auth/phone/send", { phone: "9000000003" }));
    expect(res.status).toBe(502);
    expect(errors).toHaveBeenCalled();
    expect(JSON.stringify(errors.mock.calls)).not.toMatch(/9000000003/);
    expect(JSON.stringify(await res.json())).not.toMatch(/9000000003/);
    errors.mockRestore();
  });
});
