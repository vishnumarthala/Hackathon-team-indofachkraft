// Ticket 042: synthetic Hyderabad seed. Unit: determinism (same seed -> same names/coordinates), every coordinate
// inside Hyderabad and within 800 m of its locality, >= 12 localities, all 9 provider types, 8 centres with 2-5
// providers, fictional data only (NFR-2), production guard. Database: seed -> rows flagged synthetic, verified + listed,
// searchable and bookable; --reset-synthetic removes only synthetic rows; the CLI refuses a non-local Supabase before
// writing (E-5). Skips the database part without DATABASE_URL.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { loadEnvConfig } from "@next/env";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import names from "@/scripts/data/demo-names.json";
import {
  distanceMeters,
  generateHyderabadDataset,
  HYDERABAD_BBOX,
  JITTER_METERS,
  parseSeedArgs,
  resetSynthetic,
  SEED_LOCALITIES,
  seedGuard,
  writeDataset,
} from "@/scripts/seed-hyderabad";
import { PROVIDER_TYPES } from "@/lib/providers/constants";
import { generateSlots } from "@/lib/booking/slots";
import { purgeTestAudit } from "./helpers/audit";

loadEnvConfig(process.cwd(), false, { info: () => {}, error: () => {} });
const enabled = Boolean(process.env.DATABASE_URL) && process.env.SKIP_DB_TESTS !== "1";
const run = promisify(execFile);

describe("generateHyderabadDataset (FR-1, FR-2, NFR-2)", () => {
  const plan = generateHyderabadDataset({ count: 60, seed: 42, prefix: "demo-hyd" });

  it("is deterministic: same seed -> same names, types and coordinates; another seed differs", () => {
    const again = generateHyderabadDataset({ count: 60, seed: 42, prefix: "demo-hyd" });
    expect(again).toEqual(plan);
    const other = generateHyderabadDataset({ count: 60, seed: 7, prefix: "demo-hyd" });
    expect(other.providers.map((p) => p.display_name)).not.toEqual(plan.providers.map((p) => p.display_name));
    expect(other.orgs.map((o) => o.location.lat)).not.toEqual(plan.orgs.map((o) => o.location.lat));
  });

  it("places every location in Hyderabad, within 800 m of its locality centre, across >= 12 localities", () => {
    for (const count of [60, 1000]) {
      const p = count === 60 ? plan : generateHyderabadDataset({ count, seed: 42, prefix: "demo-hyd" });
      for (const o of p.orgs) {
        const { lat, lng, locality, pincode } = o.location;
        expect(lat).toBeGreaterThan(HYDERABAD_BBOX.minLat);
        expect(lat).toBeLessThan(HYDERABAD_BBOX.maxLat);
        expect(lng).toBeGreaterThan(HYDERABAD_BBOX.minLng);
        expect(lng).toBeLessThan(HYDERABAD_BBOX.maxLng);
        const centre = SEED_LOCALITIES.find((l) => l.name === locality)!;
        expect(pincode).toBe(centre.pincode);
        expect(distanceMeters(centre, { lat, lng })).toBeLessThanOrEqual(JITTER_METERS);
      }
      expect(new Set(p.orgs.map((o) => o.location.locality)).size).toBeGreaterThanOrEqual(12);
    }
  });

  it("covers all 9 provider types, 8 centres with 2-5 providers, languages, services and weekly hours", () => {
    expect(new Set(plan.providers.map((p) => p.provider_type))).toEqual(new Set(PROVIDER_TYPES));
    const centres = plan.orgs.map((o, i) => ({ o, i })).filter(({ o }) => o.kind === "centre");
    expect(centres).toHaveLength(8);
    for (const { i } of centres) {
      const size = plan.providers.filter((p) => p.org === i).length;
      expect(size).toBeGreaterThanOrEqual(2);
      expect(size).toBeLessThanOrEqual(5);
    }
    // Speech and OT outnumber child psychiatrists in a realistic mix.
    const big = generateHyderabadDataset({ count: 1000, seed: 42, prefix: "x" }).providers;
    const n = (t: string) => big.filter((p) => p.provider_type === t).length;
    expect(n("speech_language_pathologist")).toBeGreaterThan(n("child_psychiatrist") * 2);
    for (const p of plan.providers) {
      expect(p.languages[0]).toBe("en");
      expect(p.languages.every((l) => ["en", "hi", "te", "ur"].includes(l))).toBe(true);
      expect(p.services.length).toBeGreaterThan(0);
      expect(p.services.some((s) => s.mode === "in_clinic")).toBe(true);
      expect(p.services.some((s) => s.mode === "video")).toBe(p.offers_video);
      for (const s of p.services) {
        if (s.payment_mode === "free") expect(s.fee_inr).toBe(0);
        else {
          expect(s.fee_inr).toBeGreaterThanOrEqual(500);
          expect(s.fee_inr).toBeLessThanOrEqual(2500);
        }
      }
      expect(p.rules.length).toBeGreaterThanOrEqual(10);
    }
    expect(new Set(plan.providers.flatMap((p) => p.services.map((s) => s.payment_mode))).size).toBeGreaterThanOrEqual(2);
  });

  it("uses only fictional, flagged details (FR-2, NFR-2)", () => {
    plan.providers.forEach((p, i) => {
      expect(p.display_name).toMatch(/^Dr\. \(Demo\) [A-Z][a-z]+ [A-Z]\.$/);
      expect(p.registration_number).toBe(`DEMO-${i + 1}`);
      expect(p.slug).toMatch(/^demo-hyd-\d{4}-[a-z0-9-]+$/);
      expect(p.bio).toMatch(/Synthetic demo profile/);
    });
    for (const o of plan.orgs) {
      expect(o.name.startsWith("(Demo) ")).toBe(true);
      if (o.kind === "centre") expect(o.name).toMatch(/^\(Demo\) .+ Centre( \d+)?$/);
      expect(o.phone_public).toMatch(/^\+91 90000 0\d{4}$/);
      expect(new URL(o.website).hostname.endsWith(".example.com")).toBe(true);
      expect(o.location.address_line1.startsWith("(Demo) ")).toBe(true);
    }
    // Given names + one initial only: no family names that could identify a real person.
    expect(names.initials.every((i) => /^[A-Z]$/.test(i))).toBe(true);
    expect(names.given_names.every((g) => /^[A-Z][a-z]+$/.test(g))).toBe(true);
  });

  it("generates weekly hours that produce bookable slots for every service", () => {
    const p = plan.providers[0];
    for (const s of p.services) {
      const slots = generateSlots({
        service: { mode: s.mode, location_id: s.mode === "in_clinic" ? "loc" : null, duration_min: s.duration_min, buffer_min: s.buffer_min },
        rules: p.rules.map((r) => ({ ...r, location_id: "loc", valid_from: "2020-01-01", valid_to: null, time_zone: "Asia/Kolkata" })),
        overrides: [],
        busy: [],
        from: "2026-11-16",
        days: 7,
        now: new Date("2026-11-15T00:00:00Z"),
      });
      expect(slots.length, s.name).toBeGreaterThan(0);
    }
  });
});

describe("options and production guard (FR-1, E-5)", () => {
  it("parses options", () => {
    expect(parseSeedArgs([])).toMatchObject({ count: 60, seed: 42, prefix: "demo-hyd", reset: false });
    expect(parseSeedArgs(["--count", "1000", "--seed", "7", "--prefix", "load-1", "--reset-synthetic"])).toMatchObject({
      count: 1000,
      seed: 7,
      prefix: "load-1",
      reset: true,
      prefixGiven: true,
    });
    expect(() => parseSeedArgs(["--count", "0"])).toThrow();
    expect(() => parseSeedArgs(["--prefix", "Bad Prefix"])).toThrow();
    expect(() => parseSeedArgs(["--wipe"])).toThrow(/Unknown option/);
  });

  it("allows only local Supabase + database unless ALLOW_SYNTHETIC_SEED=true", () => {
    const local = { NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321", DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres" };
    expect(seedGuard(local)).toBeNull();
    expect(seedGuard({ ...local, NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321" })).toBeNull();
    expect(seedGuard({ ...local, NEXT_PUBLIC_SUPABASE_URL: "https://abcd.supabase.co" })).toMatch(/NEXT_PUBLIC_SUPABASE_URL/);
    expect(seedGuard({ ...local, DATABASE_URL: "postgresql://postgres:x@db.abcd.supabase.co:5432/postgres" })).toMatch(/DATABASE_URL/);
    expect(seedGuard({ ...local, NEXT_PUBLIC_SUPABASE_URL: undefined })).not.toBeNull();
    expect(seedGuard({ ...local, NEXT_PUBLIC_SUPABASE_URL: "https://127.0.0.1.evil.example" })).not.toBeNull();
    expect(seedGuard({ NEXT_PUBLIC_SUPABASE_URL: "https://abcd.supabase.co", ALLOW_SYNTHETIC_SEED: "true" })).toBeNull();
    expect(seedGuard({ NEXT_PUBLIC_SUPABASE_URL: "https://abcd.supabase.co", ALLOW_SYNTHETIC_SEED: "1" })).not.toBeNull();
  });
});

describe.skipIf(!enabled)("seed:hyderabad against the database (FR-1, FR-2, FR-3)", { timeout: 120_000 }, () => {
  let sql: Sql;
  const prefix = `t042-${randomUUID().slice(0, 6)}`;
  const realSlug = `${prefix}-real-provider`;
  let realOrg: string | null = null;

  beforeAll(async () => {
    sql = postgres(process.env.DATABASE_URL as string, { max: 2, prepare: false, onnotice: () => {} });
  });

  afterAll(async () => {
    if (sql) {
      await resetSynthetic(sql, { prefix });
      await sql`delete from provider_profiles where slug = ${realSlug}`;
      if (realOrg) await sql`delete from organizations where id = ${realOrg}`;
      await purgeTestAudit(sql, (tx) => tx`delete from audit_events where entity = 'seed' and entity_id = ${prefix}`);
      await sql.end({ timeout: 5 });
    }
  });

  it("seeds flagged, verified, listed, unclaimed profiles with services and hours, and refuses a second run", async () => {
    const plan = generateHyderabadDataset({ count: 60, seed: 42, prefix });
    const summary = await writeDataset(sql, plan, { prefix, seed: 42 });
    expect(summary).toMatchObject({ action: "seed", providers: 60, centres: 8, localities: 14, types: 9 });
    const [c] = await sql<{ n: number; synthetic: number; listed: number; users: number; services: number; rules: number; locations: number; geo: number }[]>`
      select count(*)::int as n,
             count(*) filter (where p.is_synthetic)::int as synthetic,
             count(*) filter (where p.verification_status = 'verified' and p.listed and not p.claimed)::int as listed,
             count(p.user_id)::int as users,
             (select count(*)::int from services s join provider_profiles q on q.id = s.provider_profile_id where q.slug like ${`${prefix}-%`}) as services,
             (select count(*)::int from availability_rules r join provider_profiles q on q.id = r.provider_profile_id where q.slug like ${`${prefix}-%`}) as rules,
             (select count(*)::int from practice_locations l join organizations o on o.id = l.org_id where o.slug like ${`${prefix}-%`}) as locations,
             (select count(*)::int from practice_locations l join organizations o on o.id = l.org_id where o.slug like ${`${prefix}-%`} and l.geog is not null) as geo
      from provider_profiles p where p.slug like ${`${prefix}-%`}`;
    expect(c).toEqual({
      n: 60,
      synthetic: 60,
      listed: 60,
      users: 0,
      services: summary.services,
      rules: summary.rules,
      locations: summary.locations,
      geo: summary.locations,
    });
    // Searchable near Gachibowli with the demo flag (app passes SHOW_SYNTHETIC_LISTINGS), hidden when switched off.
    const near = await sql<{ slug: string; is_synthetic: boolean }[]>`select slug, is_synthetic from search_providers(17.4401, 78.3489, 5, null, null, 'any', 100)`;
    const ours = near.filter((r) => r.slug.startsWith(`${prefix}-`));
    expect(ours.length).toBeGreaterThan(0);
    expect(ours.every((r) => r.is_synthetic)).toBe(true);
    const hidden = await sql<{ slug: string }[]>`select slug from search_providers(17.4401, 78.3489, 5, null, null, 'any', 100, 0, false)`;
    expect(hidden.some((r) => r.slug.startsWith(`${prefix}-`))).toBe(false);
    // Consultation modes match the services (030 triggers).
    const modes = await sql`
      select 1 from provider_profiles p where p.slug like ${`${prefix}-%`}
        and p.offers_video is distinct from exists (select 1 from services s where s.provider_profile_id = p.id and s.mode = 'video')`;
    expect(modes.length).toBe(0);
    await expect(writeDataset(sql, plan, { prefix, seed: 42 })).rejects.toThrow(/already exist/);
  });

  it("--reset-synthetic removes only synthetic rows; a non-synthetic profile stays intact (E-3)", async () => {
    // A real (non-synthetic) profile seeded like 028's admin seeding, at one of the seed's demo organisations' localities.
    const [{ outcome }] = await sql<{ outcome: { profile_id: string; org_id: string } }[]>`
      select public.seed_provider_profile(null, ${sql.json({
        org_name: `${prefix} Real Clinic (synthetic test)`,
        org_slug: `${prefix}-real-clinic`,
        org_kind: "solo",
        location_name: "Real clinic (synthetic test)",
        address_line1: "Plot 9 (synthetic test)",
        locality: "Gachibowli",
        pincode: "500032",
        lat: 17.44,
        lng: 78.35,
        slug: realSlug,
        display_name: "Real Provider (synthetic test)",
        provider_type: "pediatrician",
        languages: ["en"],
        verified: false,
        is_synthetic: false,
      })}) as outcome`;
    realOrg = outcome.org_id;
    const before = await sql`select * from provider_profiles where id = ${outcome.profile_id}`;

    const summary = await resetSynthetic(sql, { prefix });
    expect(summary).toMatchObject({ action: "reset", providers: 60, centres: 8 });
    const [left] = await sql<{ profiles: number; orgs: number }[]>`
      select (select count(*)::int from provider_profiles where slug like ${`${prefix}-%`} and is_synthetic) as profiles,
             (select count(*)::int from organizations where slug like ${`${prefix}-%`} and name like '(Demo) %') as orgs`;
    expect(left).toEqual({ profiles: 0, orgs: 0 });
    const after = await sql`select * from provider_profiles where id = ${outcome.profile_id}`;
    expect(after).toEqual(before);
    expect((await sql`select 1 from organizations where id = ${realOrg}`).length).toBe(1);
    expect((await sql`select 1 from provider_locations where provider_profile_id = ${outcome.profile_id}`).length).toBe(1);
  });

  it("the CLI refuses a non-local Supabase before writing (E-5)", async () => {
    const env = {
      ...process.env,
      NEXT_PUBLIC_SUPABASE_URL: "https://abcd.supabase.co",
      ALLOW_SYNTHETIC_SEED: "",
    };
    const err = await run("npx", ["tsx", "scripts/seed-hyderabad.ts", "--count", "5", "--prefix", `${prefix}-cli`], { env }).catch((e) => e);
    expect(err.code).toBe(2);
    expect(String(err.stderr)).toMatch(/Refusing to write synthetic data/);
    expect((await sql`select 1 from provider_profiles where slug like ${`${prefix}-cli-%`}`).length).toBe(0);
  });
});
