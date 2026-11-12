// Ticket 018: locale / time zone resolution, the translator, and POST /api/locale.
// The database block runs against the configured local Supabase (DATABASE_URL) with a synthetic user that
// is deleted afterwards; it is skipped without DATABASE_URL or with SKIP_DB_TESTS=1.
import { randomUUID } from "node:crypto";
import { loadEnvConfig } from "@next/env";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

loadEnvConfig(process.cwd(), false, { info: () => {}, error: () => {} });
const enabled = Boolean(process.env.DATABASE_URL) && process.env.SKIP_DB_TESTS !== "1";

const request = vi.hoisted(() => ({
  cookies: new Map<string, string>(),
  headers: new Map<string, string>(),
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (request.cookies.has(name) ? { name, value: request.cookies.get(name)! } : undefined),
    getAll: () => [...request.cookies].map(([name, value]) => ({ name, value })),
  }),
  headers: async () => ({ get: (name: string) => request.headers.get(name.toLowerCase()) ?? null }),
}));

const session = vi.hoisted(() => ({ user: null as null | { id: string } }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getAuthenticatedUser: vi.fn(async () => session.user) };
});

const intake = vi.hoisted(() => ({ language: null as string | null }));
vi.mock("@/lib/queries/intake", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queries/intake")>();
  return {
    ...actual,
    getCaseByToken: vi.fn(async () => (intake.language ? { language: intake.language } : null)),
  };
});

// `undefined` = use the real database client (database block); otherwise answer profile reads with `row`.
const profile = vi.hoisted(() => ({
  row: null as undefined | null | { preferred_locale: string | null; time_zone: string | null },
}));
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return {
    ...actual,
    supabaseAdmin: vi.fn(() => {
      if (profile.row === undefined) return actual.supabaseAdmin();
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => ({ data: profile.row, error: null }),
      };
      return { from: () => chain };
    }),
  };
});

import { getAuthenticatedUser } from "@/lib/auth";
import { getCaseByToken } from "@/lib/queries/intake";
import { POST } from "@/app/api/locale/route";
import { isValidTimeZone, localeFromAcceptLanguage } from "@/lib/i18n/config";
import { getMessages, withFallback } from "@/lib/i18n/messages";
import { getLocale, getT, getTimeZone, resolveLocale, resolveTimeZone } from "@/lib/i18n/server";
import { createTranslator } from "@/lib/i18n/translate";

const SIGNED_IN_COOKIE = "sb-127-auth-token";

function reset() {
  request.cookies.clear();
  request.headers.clear();
  session.user = null;
  intake.language = null;
  profile.row = null;
  vi.mocked(getAuthenticatedUser).mockClear();
  vi.mocked(getCaseByToken).mockClear();
}

const post = (body: unknown) =>
  POST(new Request("http://localhost/api/locale", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }));

describe("resolveLocale (FR-3 order)", () => {
  it("cookie > profile > intake case language > Accept-Language > en", () => {
    const all = { cookie: "te", profileLocale: "hi", caseLanguage: "en", acceptLanguage: "hi-IN" };
    expect(resolveLocale(all)).toBe("te");
    expect(resolveLocale({ ...all, cookie: null })).toBe("hi");
    expect(resolveLocale({ ...all, cookie: null, profileLocale: null })).toBe("en");
    expect(resolveLocale({ acceptLanguage: "te-IN,te;q=0.9" })).toBe("te");
    expect(resolveLocale({})).toBe("en");
  });

  it("ignores invalid cookie, profile and case values", () => {
    expect(resolveLocale({ cookie: "fr", profileLocale: "xx", caseLanguage: "de", acceptLanguage: "hi" })).toBe("hi");
    expect(resolveLocale({ cookie: "", acceptLanguage: "fr-FR" })).toBe("en");
  });

  it("Accept-Language: q-values, region subtags and unsupported languages", () => {
    expect(localeFromAcceptLanguage("fr-FR,fr;q=0.9,te;q=0.8,hi;q=0.7")).toBe("te");
    expect(localeFromAcceptLanguage("en-US;q=0.5,hi-IN;q=0.9")).toBe("hi");
    expect(localeFromAcceptLanguage("de-DE, fr")).toBeNull();
    expect(localeFromAcceptLanguage("te;q=0")).toBeNull();
    expect(localeFromAcceptLanguage(null)).toBeNull();
  });
});

describe("resolveTimeZone (FR-5a order)", () => {
  it("cookie > profile > Asia/Kolkata, skipping invalid zones", () => {
    expect(resolveTimeZone({ cookie: "Europe/Berlin", profileTimeZone: "America/New_York" })).toBe("Europe/Berlin");
    expect(resolveTimeZone({ cookie: "Mars/Olympus", profileTimeZone: "America/New_York" })).toBe("America/New_York");
    expect(resolveTimeZone({ cookie: "", profileTimeZone: "nope" })).toBe("Asia/Kolkata");
    expect(isValidTimeZone("Asia/Kolkata")).toBe(true);
    expect(isValidTimeZone("Not/AZone")).toBe(false);
    expect(isValidTimeZone(42)).toBe(false);
  });
});

describe("getLocale / getTimeZone (mocked request)", () => {
  beforeEach(reset);

  it("anonymous: cookie wins, invalid cookie falls through to Accept-Language, no auth or profile lookup", async () => {
    request.cookies.set("dnm_locale", "hi");
    request.headers.set("accept-language", "te-IN,te;q=0.9");
    expect(await getLocale()).toBe("hi");
    request.cookies.set("dnm_locale", "fr");
    expect(await getLocale()).toBe("te");
    request.headers.clear();
    expect(await getLocale()).toBe("en");
    expect(getAuthenticatedUser).not.toHaveBeenCalled();
  });

  it("signed in without a cookie: the profile preference wins over the case language and the header", async () => {
    request.cookies.set(SIGNED_IN_COOKIE, "x");
    request.headers.set("accept-language", "en");
    request.headers.set("x-dnm-path", "/intake/tok_abc");
    session.user = { id: "u1" };
    profile.row = { preferred_locale: "hi", time_zone: "Europe/Berlin" };
    intake.language = "te";
    expect(await getLocale()).toBe("hi");
    expect(await getTimeZone()).toBe("Europe/Berlin");
    expect(getCaseByToken).not.toHaveBeenCalled();
  });

  it("intake page without cookie or profile uses the case language before Accept-Language", async () => {
    request.headers.set("accept-language", "hi-IN");
    request.headers.set("x-dnm-path", "/intake/tok_abc");
    intake.language = "te";
    expect(await getLocale()).toBe("te");
    expect(getCaseByToken).toHaveBeenCalledWith("tok_abc");

    request.headers.set("x-dnm-path", "/intake/tok_abc/extra");
    expect(await getLocale()).toBe("hi");
    request.headers.set("x-dnm-path", "/dashboard");
    expect(await getLocale()).toBe("hi");
  });

  it("an intake page with a cookie keeps the cookie locale", async () => {
    request.cookies.set("dnm_locale", "en");
    request.headers.set("x-dnm-path", "/intake/tok_abc");
    intake.language = "te";
    expect(await getLocale()).toBe("en");
  });

  it("time zone: valid cookie, invalid cookie ignored, default Asia/Kolkata", async () => {
    request.cookies.set("dnm_tz", "America/New_York");
    expect(await getTimeZone()).toBe("America/New_York");
    request.cookies.set("dnm_tz", "Invalid/Zone");
    expect(await getTimeZone()).toBe("Asia/Kolkata");
  });

  it("getT uses the resolved locale and supports namespaces", async () => {
    request.cookies.set("dnm_locale", "te");
    const t = await getT("login");
    expect(t("title")).toBe("మళ్ళీ స్వాగతం");
    expect((await getT())("language.label")).toBe("భాష");
  });
});

describe("translator (FR-4)", () => {
  const messages = {
    greet: "Hello {name}",
    items_one: "{count} item",
    items_other: "{count} items",
    nested: { only: "Only en" },
  };

  it("interpolates, leaves a missing variable literal and warns once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = createTranslator("en", messages) as unknown as (k: string, v?: Record<string, string | number>) => string;
    expect(t("greet", { name: "Lakshmi" })).toBe("Hello Lakshmi");
    expect(t("greet")).toBe("Hello {name}");
    expect(t("greet")).toBe("Hello {name}");
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("plural forms via Intl.PluralRules with _one / _other and Indian digit grouping", () => {
    const t = createTranslator("en", messages) as unknown as (k: string, v?: Record<string, string | number>) => string;
    expect(t("items", { count: 1 })).toBe("1 item");
    expect(t("items", { count: 150000 })).toBe("1,50,000 items");
    const real = createTranslator("en", getMessages("en"), "landing.features");
    expect(real("fromConfirmed", { count: 1 })).toBe("from 1 confirmed item");
    expect(real("fromConfirmed", { count: 38 })).toBe("from 38 confirmed items");
  });

  it("a key missing in hi/te falls back to en with one warning per key", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const merged = withFallback({ greet: "नमस्ते {name}" }, messages, "hi-test");
    const t = createTranslator("hi", merged) as unknown as (k: string, v?: Record<string, string | number>) => string;
    expect(t("greet", { name: "रवि" })).toBe("नमस्ते रवि");
    expect(t("nested.only")).toBe("Only en");
    expect(warn.mock.calls.filter(([m]) => String(m).includes("nested.only"))).toHaveLength(1);
    withFallback({ greet: "x" }, messages, "hi-test");
    expect(warn.mock.calls.filter(([m]) => String(m).includes("nested.only"))).toHaveLength(1);
    warn.mockRestore();
  });

  it("an unknown key renders the key itself", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = createTranslator("en", getMessages("en"));
    // @ts-expect-error unknown keys are a type error (FR-2)
    expect(t("unknown.key")).toBe("unknown.key");
    warn.mockRestore();
  });
});

describe("POST /api/locale (FR-8, anonymous)", () => {
  beforeEach(reset);

  it("rejects an unsupported locale with the FR-8 body", async () => {
    const res = await post({ locale: "fr" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid request", details: { locale: "Choose English, Hindi or Telugu" } });
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("rejects an empty body, non-JSON and an invalid time zone", async () => {
    expect((await post({})).status).toBe(400);
    expect((await post("not json")).status).toBe(400);
    const res = await post({ time_zone: "Mars/Olympus" });
    expect(res.status).toBe(400);
    expect((await res.json()).details).toEqual({ time_zone: "Use an IANA time zone such as Asia/Kolkata" });
  });

  it("sets an HttpOnly, Lax, one-year dnm_locale cookie and never touches auth when anonymous", async () => {
    const res = await post({ locale: "te" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ locale: "te" });
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/^dnm_locale=te;/);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).toMatch(/Max-Age=31536000/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=lax/i);
    expect(cookie).not.toMatch(/Secure/i);
    expect(getAuthenticatedUser).not.toHaveBeenCalled();
  });

  it("stores a canonical time zone in dnm_tz", async () => {
    const res = await post({ time_zone: "europe/berlin" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ time_zone: "Europe/Berlin" });
    expect(res.headers.get("set-cookie")).toMatch(/^dnm_tz=Europe%2FBerlin;|^dnm_tz=Europe\/Berlin;/);
  });

  it("Secure in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const res = await post({ locale: "hi" });
    vi.unstubAllEnvs();
    expect(res.headers.get("set-cookie")).toMatch(/Secure/);
  });
});

describe.skipIf(!enabled)("signed-in preference (database, E-2)", { timeout: 60_000 }, () => {
  let sql: Sql;
  let db: ReturnType<typeof import("@/lib/db").supabaseAdmin>;
  let userId: string;

  beforeAll(async () => {
    sql = postgres(process.env.DATABASE_URL as string, { max: 2, prepare: false, onnotice: () => {} });
    profile.row = undefined;
    db = (await import("@/lib/db")).supabaseAdmin();
    const { data, error } = await db.auth.admin.createUser({
      email: `t018-${randomUUID().slice(0, 8)}@example.com`,
      email_confirm: true,
      password: randomUUID(),
    });
    if (error || !data.user) throw new Error(`createUser failed: ${error?.message}`);
    userId = data.user.id;
  });

  afterAll(async () => {
    if (userId) await db.auth.admin.deleteUser(userId);
    await sql?.end({ timeout: 5 });
    profile.row = null;
  });

  beforeEach(() => {
    request.cookies.clear();
    request.headers.clear();
    request.cookies.set(SIGNED_IN_COOKIE, "x");
    session.user = { id: userId };
    profile.row = undefined;
  });

  it("choosing हिन्दी saves preferred_locale = 'hi' on the user's own profile", async () => {
    const res = await post({ locale: "hi" });
    expect(res.status).toBe(200);
    const [row] = await sql<{ preferred_locale: string | null }[]>`select preferred_locale from user_profiles where id = ${userId}`;
    expect(row.preferred_locale).toBe("hi");
  });

  it("a fresh browser (no locale cookie) gets Hindi from the profile, and the zone from the profile", async () => {
    await post({ time_zone: "America/New_York" });
    request.cookies.clear();
    request.cookies.set(SIGNED_IN_COOKIE, "x");
    request.headers.set("accept-language", "en-US");
    expect(await getLocale()).toBe("hi");
    expect(await getTimeZone()).toBe("America/New_York");
  });

  it("the database rejects an unsupported preferred_locale", async () => {
    await expect(sql`update user_profiles set preferred_locale = 'fr' where id = ${userId}`).rejects.toThrow(/check/i);
  });
});
