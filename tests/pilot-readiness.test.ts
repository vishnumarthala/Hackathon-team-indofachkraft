// Ticket 056: pilot go/no-go checks (/admin/ops) and the new centre's setup checklist (/dashboard).
import { loadEnvConfig } from "@next/env";
import postgres, { type Sql } from "postgres";
import { createElement } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupSteps, type SetupFacts } from "@/lib/dashboard/setup";
import { DEFAULT_EMAIL_FROM } from "@/lib/env";
import { pilotReadiness, pilotVerdict, type ReadinessCheckId } from "@/lib/readiness/pilot";
import { withI18n } from "./helpers/i18n";
import { createWorld } from "./helpers/world";

const PILOT_ENV = {
  DEMO_MODE: "false",
  SHOW_SYNTHETIC_LISTINGS: "false",
  NEXT_PUBLIC_APP_URL: "https://doctornearme.example",
  CRON_SECRET: "cron",
  RESEND_API_KEY: "re_test",
  EMAIL_FROM: "DoctorNearMe <care@doctornearme.example>",
  PRIVACY_NOTICE_REVIEWED: "true",
  GRIEVANCE_OFFICER_EMAIL: "grievance@doctornearme.example",
  ELEVENLABS_API_KEY: "el",
  ELEVENLABS_AGENT_ID: "agent",
  ELEVENLABS_WEBHOOK_SECRET: "wh",
  GEMINI_API_KEY: "gm",
};
const ok = (env: Record<string, string | undefined>, phoneSignIn = false) => {
  const checks = pilotReadiness({ env, googleSignIn: true, phoneSignIn });
  return { verdict: pilotVerdict(checks), get: (id: ReadinessCheckId) => checks.find((c) => c.id === id)! };
};

describe("pilot readiness (056)", () => {
  it("a free pilot with Google-only sign-in and no payments is ready; deferred items never block", () => {
    const r = ok(PILOT_ENV);
    expect(r.verdict).toBe("ready");
    expect(r.get("phoneSignIn")).toEqual({ id: "phoneSignIn", level: "warn", ok: false });
    expect(r.get("paymentsDeferred")).toEqual({ id: "paymentsDeferred", level: "deferred", ok: true });
    expect(r.get("mchatDeferred").ok).toBe(true);
  });

  it.each([
    ["demoModeOff", { DEMO_MODE: "true" }],
    ["syntheticHidden", { SHOW_SYNTHETIC_LISTINGS: undefined }],
    ["appUrlHttps", { NEXT_PUBLIC_APP_URL: "http://localhost:3000" }],
    ["cronSecret", { CRON_SECRET: "" }],
    ["email", { EMAIL_FROM: undefined }],
    ["email", { EMAIL_FROM: DEFAULT_EMAIL_FROM }],
    ["privacyReviewed", { PRIVACY_NOTICE_REVIEWED: undefined }],
    ["grievanceOfficer", { GRIEVANCE_OFFICER_EMAIL: undefined }],
    ["intakeVoice", { ELEVENLABS_WEBHOOK_SECRET: undefined }],
    ["aiNotes", { GEMINI_API_KEY: undefined }],
    ["paymentsConsistent", { PAYMENTS_ENABLED: "true" }],
  ] as const)("%s blocks the pilot", (id, patch) => {
    const r = ok({ ...PILOT_ENV, ...patch });
    expect(r.get(id)).toMatchObject({ level: "block", ok: false });
    expect(r.verdict).toBe("blocked");
  });

  it("no family sign-in method at all blocks; payments on with Razorpay keys is consistent but no longer deferred", () => {
    expect(pilotVerdict(pilotReadiness({ env: PILOT_ENV, googleSignIn: false, phoneSignIn: false }))).toBe("blocked");
    const r = ok({ ...PILOT_ENV, PAYMENTS_ENABLED: "true", RAZORPAY_KEY_ID: "rzp_test_x", RAZORPAY_KEY_SECRET: "s", RAZORPAY_WEBHOOK_SECRET: "w" });
    expect(r.verdict).toBe("ready");
    expect(r.get("paymentsDeferred").ok).toBe(false);
  });
});

describe("centre setup checklist steps (056)", () => {
  const none: SetupFacts = { team: false, children: false, family: false, timetable: false, note: false, homeProgram: false };

  it("links every step to where the work happens", () => {
    const steps = setupSteps(none, { firstCaseId: "c1", caseWithoutParentId: "c2" });
    expect(steps.map((s) => [s.id, s.href])).toEqual([
      ["team", "/dashboard/team"],
      ["children", "/dashboard/import"],
      ["family", "/cases/c2#parent-code"],
      ["timetable", "/cases/c1"],
      ["note", "/cases/c1/sessions"],
      ["homeProgram", "/cases/c1/home-program"],
    ]);
  });

  it("without any case, case steps send the centre to the import first", () => {
    const steps = setupSteps({ ...none, team: true }, { firstCaseId: null, caseWithoutParentId: null });
    expect(steps.filter((s) => s.id !== "team" && s.id !== "children").every((s) => s.href.startsWith("/dashboard/import"))).toBe(true);
    expect(steps[0].done).toBe(true);
  });
});

loadEnvConfig(process.cwd(), false, { info: () => {}, error: () => {} });
const enabled = Boolean(process.env.DATABASE_URL) && process.env.SKIP_DB_TESTS !== "1";

describe("family sign-in methods without an SMS provider (056)", () => {
  const settings = (external: Record<string, boolean>) =>
    vi.fn(async () => new Response(JSON.stringify({ external }), { status: 200, headers: { "Content-Type": "application/json" } }));

  beforeEach(async () => {
    (await import("@/lib/family/auth-settings")).resetAuthSettingsCache();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://supabase.test");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
    vi.stubEnv("DEMO_MODE", "false");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("phone follows Supabase's phone provider; DEMO_MODE keeps the synthetic numbers working", async () => {
    const { isGoogleAuthEnabled, isPhoneAuthEnabled, resetAuthSettingsCache } = await import("@/lib/family/auth-settings");
    vi.stubGlobal("fetch", settings({ google: true, phone: false }));
    expect(await isGoogleAuthEnabled()).toBe(true);
    expect(await isPhoneAuthEnabled()).toBe(false);
    resetAuthSettingsCache();
    vi.stubGlobal("fetch", settings({ google: true, phone: true }));
    expect(await isPhoneAuthEnabled()).toBe(true);
    resetAuthSettingsCache();
    vi.stubGlobal("fetch", settings({ google: false, phone: false }));
    vi.stubEnv("DEMO_MODE", "true");
    expect(await isPhoneAuthEnabled()).toBe(true);
  });

  it("the login shows Google only with a note when phone is off, and the phone form when it is on", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { FamilyLoginForm } = await import("@/components/family/FamilyLoginForm");
    const en = (await import("@/messages/en.json")).default;
    const render = (phoneEnabled: boolean) =>
      renderToStaticMarkup(withI18n(createElement(FamilyLoginForm, { appUrl: "https://x.test", nextPath: "/family", googleEnabled: true, phoneEnabled })));
    const off = render(false);
    expect(off).toContain(en.family.login.google);
    expect(off).not.toContain(en.family.login.sendCode);
    expect(off).toContain(en.family.login.phoneUnavailable);
    const on = render(true);
    expect(on).toContain(en.family.login.sendCode);
    expect(on).not.toContain(en.family.login.phoneUnavailable);
  });
});

describe.skipIf(!enabled)("centre setup facts (database, 056)", () => {
  let sql: Sql;
  let world: ReturnType<typeof createWorld>;

  beforeAll(async () => {
    sql = postgres(process.env.DATABASE_URL as string, { max: 2, prepare: false, onnotice: () => {} });
    world = createWorld(sql, (await import("@/lib/db")).supabaseAdmin(), "t056");
  });
  afterAll(async () => {
    if (!sql) return;
    await world.cleanup();
    await sql.end();
  });

  it("each step turns done from real data, scoped to the owner's organisation", async () => {
    const { loadSetupFacts } = await import("@/lib/dashboard/setup");
    const owner = await world.user("owner", "provider");
    const outsider = await world.user("outsider", "provider");
    const orgId = await world.org(owner, "Pilot centre");
    expect(await loadSetupFacts(owner.id)).toEqual({ team: false, children: false, family: false, timetable: false, note: false, homeProgram: false });

    const therapist = await world.user("therapist", "provider");
    await world.member(orgId, therapist);
    const { caseId, recordingId, childId } = await world.kase(orgId);
    const parent = await world.user("parent", "guardian");
    await world.link(childId, parent);
    await sql`
      insert into reports (case_id, recording_id, kind, content, content_md, status)
      values (${caseId}, ${recordingId}, 'session_note', '{}'::jsonb, '# Note (synthetic)', 'draft')`;

    expect(await loadSetupFacts(owner.id)).toMatchObject({ team: true, children: true, family: true, note: true, timetable: false, homeProgram: false });
    // Another provider's empty workspace sees none of it.
    expect(await loadSetupFacts(outsider.id)).toMatchObject({ team: false, children: false, family: false, note: false });
  });
});
