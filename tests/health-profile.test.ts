// Ticket 021: child health profile. Schema limits, NKA exclusivity, healthSummary, the guardian GET/PUT API
// (version 0, optimistic concurrency 409, validation 400), history row per save (append-only), audit details
// without values, provider read through a case (FR-5) with authz negatives (NFR-1), RLS, and the
// `health_profile` share loader. DB suites need the local Supabase stack (DATABASE_URL). Synthetic data only.
import { randomUUID } from "node:crypto";
import { loadEnvConfig } from "@next/env";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { healthSaveStatus } from "@/components/health/HealthProfileForm";
import {
  HEALTH_CONFLICT_ERROR,
  HealthProfilePutSchema,
  NKA_ERROR,
  NO_KNOWN_ALLERGIES,
  emptyHealthProfile,
  healthFieldErrors,
  sectionsOf,
  severeAllergies,
  type HealthProfile,
} from "@/lib/health/schema";
import { healthProfileMarkdown, healthSummary } from "@/lib/health/summary";
import { SHARE_LOADERS } from "@/lib/sharing/registry";
import { createWorld, ctx, type TestUser } from "./helpers/world";

loadEnvConfig(process.cwd(), false, { info: () => {}, error: () => {} });
const enabled = Boolean(process.env.DATABASE_URL) && process.env.SKIP_DB_TESTS !== "1";

const session = vi.hoisted(() => ({ user: null as null | { id: string; email: string } }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getAuthenticatedUser: vi.fn(async () => session.user) };
});

const parse = (body: Record<string, unknown>) => HealthProfilePutSchema.safeParse({ version: 0, ...body });
const errorsOf = (body: Record<string, unknown>) => {
  const r = parse(body);
  return r.success ? {} : healthFieldErrors(r.error);
};

describe("health profile schema (FR-2)", () => {
  it("accepts the documented shapes and normalises empties", () => {
    const r = parse({
      blood_group: "O+",
      allergies: [{ substance: " Peanut ", reaction: "hives", severity: "severe" }],
      medications: [{ name: "Synthetic syrup", dose: "5 ml", frequency: "twice daily", since: "2026-01" }],
      conditions: [{ name: "Synthetic condition", since: "", notes: "" }],
      birth_history: "  ",
      emergency_contact_name: "Synthetic aunt",
      emergency_contact_phone: "98765 43210",
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.allergies[0]).toEqual({ substance: "Peanut", reaction: "hives", severity: "severe" });
    expect(r.data.conditions[0]).toEqual({ name: "Synthetic condition", since: undefined, notes: undefined });
    expect(r.data.birth_history).toBeNull();
    expect(r.data.developmental_history).toBeNull();
    expect(r.data.emergency_contact_phone).toBe("+919876543210");
    expect(parse({ allergies: [{ substance: "Dust" }] }).data?.allergies[0]).toEqual({ substance: "Dust", reaction: "", severity: "unknown" });
  });

  it("enforces length and count limits", () => {
    const many = (n: number, item: Record<string, string>) => Array.from({ length: n }, () => item);
    expect(errorsOf({ allergies: [{ substance: "x".repeat(81) }] })).toHaveProperty(["allergies.0.substance"]);
    expect(errorsOf({ allergies: [{ substance: "" }] })).toHaveProperty(["allergies.0.substance"]);
    expect(errorsOf({ allergies: [{ substance: "x", reaction: "r".repeat(201) }] })).toHaveProperty(["allergies.0.reaction"]);
    expect(errorsOf({ allergies: [{ substance: "x", severity: "deadly" }] })).toHaveProperty(["allergies.0.severity"]);
    expect(parse({ allergies: many(30, { substance: "x" }) }).success).toBe(true);
    expect(errorsOf({ allergies: many(31, { substance: "x" }) })).toHaveProperty(["allergies"]);
    expect(errorsOf({ medications: [{ name: "m".repeat(81) }] })).toHaveProperty(["medications.0.name"]);
    expect(errorsOf({ medications: [{ name: "m", dose: "d".repeat(41) }] })).toHaveProperty(["medications.0.dose"]);
    expect(errorsOf({ medications: [{ name: "m", frequency: "f".repeat(61) }] })).toHaveProperty(["medications.0.frequency"]);
    expect(errorsOf({ medications: [{ name: "m", since: "2026-13" }] })).toHaveProperty(["medications.0.since"]);
    expect(errorsOf({ medications: [{ name: "m", since: "Jan 2026" }] })).toHaveProperty(["medications.0.since"]);
    expect(errorsOf({ medications: many(31, { name: "m" }) })).toHaveProperty(["medications"]);
    expect(errorsOf({ conditions: [{ name: "c".repeat(121) }] })).toHaveProperty(["conditions.0.name"]);
    expect(errorsOf({ conditions: [{ name: "c", notes: "n".repeat(301) }] })).toHaveProperty(["conditions.0.notes"]);
    expect(errorsOf({ conditions: many(31, { name: "c" }) })).toHaveProperty(["conditions"]);
    expect(parse({ birth_history: "b".repeat(2000), developmental_history: "d".repeat(4000) }).success).toBe(true);
    expect(errorsOf({ birth_history: "b".repeat(2001) })).toHaveProperty(["birth_history"]);
    expect(errorsOf({ developmental_history: "d".repeat(4001) })).toHaveProperty(["developmental_history"]);
    expect(errorsOf({ emergency_contact_name: "n".repeat(81) })).toHaveProperty(["emergency_contact_name"]);
    expect(errorsOf({ emergency_contact_phone: "12345" })).toHaveProperty(["emergency_contact_phone"]);
    expect(parse({ emergency_contact_phone: "+44 20 7946 0000" }).data?.emergency_contact_phone).toBe("+442079460000");
    expect(errorsOf({ blood_group: "C+" })).toHaveProperty(["blood_group"]);
    expect(errorsOf({ version: -1 })).toHaveProperty(["version"]);
    expect(HealthProfilePutSchema.safeParse({}).success).toBe(false); // version is required
  });

  it("NKA is allowed only as the single allergy entry", () => {
    const only = parse({ allergies: [{ substance: "no known allergies", severity: "severe" }] });
    expect(only.data?.allergies).toEqual([{ substance: NO_KNOWN_ALLERGIES, reaction: "", severity: "unknown" }]);
    const mixed = errorsOf({ allergies: [{ substance: NO_KNOWN_ALLERGIES }, { substance: "Peanut", severity: "severe" }] });
    expect(mixed).toEqual({ allergies: NKA_ERROR });
    expect(severeAllergies({ allergies: only.data?.allergies ?? [] })).toEqual([]);
  });

  it("maps field paths to UI sections and API answers to editor states", () => {
    expect(sectionsOf(["emergency_contact_phone", "allergies.0.substance", "blood_group", "nonsense"])).toEqual([
      "allergies",
      "emergency_contact",
      "blood_group",
    ]);
    expect(healthSaveStatus(409)).toEqual({ kind: "conflict" });
    expect(healthSaveStatus(400, { allergies: NKA_ERROR })).toEqual({ kind: "nka" });
    expect(healthSaveStatus(400, { "medications.1.name": "Required" })).toEqual({ kind: "invalid", sections: ["medications"] });
    expect(healthSaveStatus(503)).toEqual({ kind: "failed" });
  });
});

describe("healthSummary (FR-7)", () => {
  const base = emptyHealthProfile(randomUUID());

  it("summarises allergies, medicines and conditions in one line", () => {
    const profile: HealthProfile = {
      ...base,
      allergies: [
        { substance: "Peanut", reaction: "hives", severity: "severe" },
        { substance: "Dust", reaction: "", severity: "unknown" },
      ],
      medications: [{ name: "Synthetic syrup", dose: "5 ml", frequency: "twice daily" }],
      conditions: [{ name: "Synthetic asthma", since: "2025-06" }],
    };
    expect(healthSummary(profile)).toBe(
      "Allergies: Peanut (severe, hives), Dust; Medicines: Synthetic syrup 5 ml twice daily; Conditions: Synthetic asthma (since 2025-06)",
    );
  });

  it("distinguishes not recorded from no known allergies", () => {
    expect(healthSummary(null)).toBe("Allergies: not recorded; Medicines: not recorded; Conditions: not recorded");
    expect(healthSummary({ ...base, allergies: [{ substance: NO_KNOWN_ALLERGIES, reaction: "", severity: "unknown" }] })).toBe(
      "Allergies: No known allergies; Medicines: not recorded; Conditions: not recorded",
    );
  });

  it("markdown for the shared view escapes guardian free text", () => {
    const md = healthProfileMarkdown({ ...base, allergies: [{ substance: "[x](http://evil) <b>", reaction: "", severity: "mild" }] });
    expect(md).toContain("## Allergies");
    expect(md).toContain("\\[x\\]\\(http://evil\\) \\<b\\>");
    expect(md).not.toContain("[x](http://evil)");
  });
});

describe.skipIf(!enabled)("health profile (database)", { timeout: 90_000 }, () => {
  let sql: Sql;
  let world: ReturnType<typeof createWorld>;
  let ownerA: TestUser, providerA: TestUser, providerB: TestUser, guardianA: TestUser, guardianB: TestUser;
  let orgA: string, orgB: string;
  let childId: string, caseA: string, otherCaseA: string, otherChild: string;

  const as = (u: TestUser | null) => {
    session.user = u;
  };

  const family = () => import("@/app/api/family/children/[id]/health/route");
  const caseRoute = () => import("@/app/api/cases/[id]/health/route");

  async function getFamily(child = childId) {
    return (await family()).GET(new Request("http://localhost/x"), ctx({ id: child }));
  }
  async function put(body: unknown, child = childId) {
    const req = new Request("http://localhost/x", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    return (await family()).PUT(req, ctx({ id: child }));
  }
  async function getCaseHealth(kase = caseA) {
    return (await caseRoute()).GET(new Request("http://localhost/x"), ctx({ id: kase }));
  }

  const peanut = { substance: "Peanut", reaction: "hives", severity: "severe" };
  const syrup = { name: "Synthetic syrup", dose: "5 ml", frequency: "twice daily" };
  const auditRows = () =>
    sql<{ details: { fields: string[]; version: number }; actor: string; actor_user_id: string }[]>`
      select details, actor, actor_user_id from audit_events
      where action = 'health_profile.updated' and entity_id = ${childId} order by id`;

  beforeAll(async () => {
    sql = postgres(process.env.DATABASE_URL as string, { max: 4, prepare: false, onnotice: () => {} });
    const db = (await import("@/lib/db")).supabaseAdmin();
    world = createWorld(sql, db, "t021h");
    ownerA = await world.user("owner-a", "provider");
    providerA = await world.user("provider-a", "provider");
    providerB = await world.user("provider-b", "provider");
    guardianA = await world.user("guardian-a", "guardian", { phoneVerified: true });
    guardianB = await world.user("guardian-b", "guardian", { phoneVerified: true });
    await sql`update user_profiles set display_name = 'Synthetic Parent A' where id = ${guardianA.id}`;
    orgA = await world.org(ownerA, "Centre A");
    orgB = await world.org(providerB, "Solo B");
    await world.member(orgA, providerA);
    ({ caseId: caseA, childId } = await world.kase(orgA));
    ({ caseId: otherCaseA, childId: otherChild } = await world.kase(orgA));
    await world.kase(orgB); // org B treats another child only
    await sql`insert into case_assignments (case_id, user_id, care_role, assigned_by) values (${caseA}, ${providerA.id}, 'member', ${ownerA.id})`;
    await world.link(childId, guardianA);
  });

  afterAll(async () => {
    if (sql && childId) await sql`delete from audit_events where action = 'health_profile.updated' and entity_id in ${sql([childId, otherChild])}`;
    await world?.cleanup();
    await sql?.end({ timeout: 5 });
  });

  beforeEach(() => as(null));

  it("E-4.2 / E-3.2: anonymous 401, unlinked guardian 404, provider 403 on the family API", async () => {
    expect((await getFamily()).status).toBe(401);
    as(guardianB);
    const other = await getFamily();
    expect(other.status).toBe(404);
    expect(await other.json()).toEqual({ error: "Child not found" });
    expect((await put({ version: 0, allergies: [peanut] })).status).toBe(404);
    expect((await getFamily("not-a-uuid")).status).toBe(404);
    as(providerA);
    expect((await put({ version: 0, allergies: [peanut] })).status).toBe(403);
    expect((await getFamily()).status).toBe(403);
    expect(await sql`select 1 from child_health_profiles where child_id = ${childId}`).toHaveLength(0);
  });

  it("FR-3: a linked guardian gets the empty profile with version 0", async () => {
    as(guardianA);
    const res = await getFamily();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const { profile } = await res.json();
    expect(profile).toMatchObject({ child_id: childId, version: 0, allergies: [], medications: [], conditions: [] });
  });

  it("E-1: save persists with version 1; NKA with an allergy and bad fields give 400 without writing", async () => {
    as(guardianA);
    const nka = await put({ version: 0, allergies: [{ substance: NO_KNOWN_ALLERGIES }, peanut] });
    expect(nka.status).toBe(400);
    expect((await nka.json()).details).toEqual({ allergies: NKA_ERROR });
    const bad = await put({ version: 0, medications: [{ name: "" }], emergency_contact_phone: "12" });
    expect(bad.status).toBe(400);
    expect(Object.keys((await bad.json()).details).sort()).toEqual(["emergency_contact_phone", "medications.0.name"]);
    expect((await put("{not json")).status).toBe(400);
    expect(await sql`select 1 from child_health_profiles where child_id = ${childId}`).toHaveLength(0);

    const saved = await put({ version: 0, allergies: [peanut], medications: [syrup] });
    expect(saved.status).toBe(200);
    expect((await saved.json()).profile).toMatchObject({ version: 1, updated_by: guardianA.id });
    const { profile } = await (await getFamily()).json();
    expect(profile).toMatchObject({ version: 1, allergies: [peanut], medications: [syrup] });
    expect(profile.updated_at).toBeTruthy();
  });

  it("E-2: a stale version gets the 409 message and is not written; races let exactly one save win", async () => {
    as(guardianA);
    const tab1 = await put({ version: 1, allergies: [peanut], medications: [syrup], blood_group: "O+" });
    expect(tab1.status).toBe(200);
    expect((await tab1.json()).profile.version).toBe(2);
    const tab2 = await put({ version: 1, allergies: [], medications: [], birth_history: "Tab 2 text (synthetic)" });
    expect(tab2.status).toBe(409);
    expect(await tab2.json()).toEqual({ error: HEALTH_CONFLICT_ERROR });
    const [row] = await sql`select version, blood_group, birth_history, allergies from child_health_profiles where child_id = ${childId}`;
    expect(row).toMatchObject({ version: 2, blood_group: "O+", birth_history: null, allergies: [peanut] });

    // Creating twice from version 0 is a conflict too.
    expect((await put({ version: 0, allergies: [peanut] })).status).toBe(409);

    // Two concurrent saves from the same version: one 200, one 409, one new version.
    const results = await Promise.all([
      put({ version: 2, allergies: [peanut], medications: [syrup], blood_group: "O+", conditions: [{ name: "Synthetic asthma" }] }),
      put({ version: 2, allergies: [peanut], medications: [syrup], blood_group: "A+" }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const [after] = await sql<{ version: number }[]>`select version from child_health_profiles where child_id = ${childId}`;
    expect(after.version).toBe(3);
  });

  it("FR-1 / FR-6: one history row per save with changed field names; history is append-only", async () => {
    const rows = await sql<{ version: number; changed_fields: string[]; changed_by: string; snapshot: { version: number } }[]>`
      select version, changed_fields, changed_by, snapshot from child_health_profile_history where child_id = ${childId} order by version`;
    expect(rows.map((r) => r.version)).toEqual([1, 2, 3]);
    expect(rows[0].changed_fields).toEqual(["allergies", "medications"]);
    expect(rows[1].changed_fields).toEqual(["blood_group"]);
    expect(rows.every((r) => r.changed_by === guardianA.id && r.snapshot.version === r.version)).toBe(true);

    const { listHealthHistory, getHealthHistoryVersion } = await import("@/lib/queries/health");
    const list = await listHealthHistory(childId);
    expect(list.map((e) => e.version)).toEqual([3, 2, 1]);
    expect(list[0].changed_by_name).toBe("Synthetic Parent A");
    const v1 = await getHealthHistoryVersion(childId, 1);
    expect(v1?.profile).toMatchObject({ child_id: childId, version: 1, allergies: [peanut], blood_group: null });
    expect(await getHealthHistoryVersion(childId, 99)).toBeNull();

    await expect(sql`update child_health_profile_history set snapshot = '{}'::jsonb where child_id = ${childId}`).rejects.toThrow(/append-only/);
    const db = (await import("@/lib/db")).supabaseAdmin();
    const del = await db.from("child_health_profile_history").delete().eq("child_id", childId);
    expect(del.error?.message).toMatch(/permission denied/);
    // A direct write still versions and records history (the trigger owns version/updated_at).
    await sql`update child_health_profiles set version = 100, developmental_history = 'Direct (synthetic)' where child_id = ${childId}`;
    const [direct] = await sql<{ version: number }[]>`select version from child_health_profiles where child_id = ${childId}`;
    expect(direct.version).toBe(4);
    const [h4] = await sql<{ changed_fields: string[] }[]>`
      select changed_fields from child_health_profile_history where child_id = ${childId} and version = 4`;
    expect(h4.changed_fields).toEqual(["developmental_history"]);
  });

  it("E-5.2 / NFR-3: audit health_profile.updated lists field names only, never values", async () => {
    const rows = await auditRows();
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ actor: "parent", actor_user_id: guardianA.id, details: { fields: ["allergies", "medications"], version: 1 } });
    const text = JSON.stringify(rows.map((r) => r.details));
    for (const value of ["Peanut", "hives", "Synthetic syrup", "5 ml", "O+", "A+", "asthma"]) expect(text).not.toContain(value);
  });

  it("E-3 / FR-5: an assigned provider of the case's org reads the profile (no-store); severe allergies listed", async () => {
    as(providerA);
    const res = await getCaseHealth();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const body = await res.json();
    expect(body.profile.allergies).toEqual([peanut]);
    expect(body.updated_at).toBe(body.profile.updated_at);
    expect(severeAllergies(body.profile).map((a) => a.substance)).toEqual(["Peanut"]);
    as(ownerA);
    expect((await getCaseHealth()).status).toBe(200);
    expect((await getCaseHealth(otherCaseA)).status).toBe(404); // accessible case, child without a profile
  });

  it("E-4: other org without a case 404, guardian 403, unassigned member 404, revoked member 404", async () => {
    as(providerB);
    expect((await getCaseHealth()).status).toBe(404);
    as(guardianA);
    expect((await getCaseHealth()).status).toBe(403);
    as(providerA);
    expect((await getCaseHealth(otherCaseA)).status).toBe(404); // member not assigned to that case
    const { revokeMember } = await import("@/lib/orgs");
    expect((await revokeMember(orgA, providerA.id)).ok).toBe(true);
    expect((await getCaseHealth()).status).toBe(404);
  });

  it("typed read helpers for later tickets (035, 039)", async () => {
    const { getPrescribingHealthFacts, getHealthProfileForCase } = await import("@/lib/queries/health");
    const facts = await getPrescribingHealthFacts(childId);
    expect(facts).toMatchObject({ recorded: true, noKnownAllergies: false, allergies: [peanut], version: 4 });
    expect(facts.medications[0]).toMatchObject(syrup);
    expect(await getPrescribingHealthFacts(otherChild)).toMatchObject({ recorded: false, allergies: [], medications: [] });
    expect(healthSummary(await getHealthProfileForCase(caseA))).toMatch(/^Allergies: Peanut \(severe, hives\); Medicines: Synthetic syrup 5 ml twice daily/);
    expect(await getHealthProfileForCase(otherCaseA)).toBeNull();
  });

  it("RLS: guardians and treating providers read the profile; history is guardian-only; no client writes", async () => {
    const count = (userId: string, table: "child_health_profiles" | "child_health_profile_history") =>
      sql.begin(async (tx) => {
        await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, role: "authenticated" })}, true)`;
        await tx`set local role authenticated`;
        const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from ${tx(table)} where child_id = ${childId}`;
        return n;
      });
    expect(await count(guardianA.id, "child_health_profiles")).toBe(1);
    expect(await count(ownerA.id, "child_health_profiles")).toBe(1);
    expect(await count(guardianB.id, "child_health_profiles")).toBe(0);
    expect(await count(providerB.id, "child_health_profiles")).toBe(0);
    expect(await count(providerA.id, "child_health_profiles")).toBe(0); // revoked above
    expect(await count(guardianA.id, "child_health_profile_history")).toBe(4);
    expect(await count(ownerA.id, "child_health_profile_history")).toBe(0);
    await expect(
      sql.begin(async (tx) => {
        await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: guardianA.id, role: "authenticated" })}, true)`;
        await tx`set local role authenticated`;
        await tx`update child_health_profiles set blood_group = 'B+' where child_id = ${childId}`;
      }),
    ).rejects.toThrow(/permission denied/);
  });

  it("share loader: one item per source org for the child only; other child or no source orgs give nothing", async () => {
    const loader = SHARE_LOADERS.health_profile;
    expect(loader).toBeDefined();
    if (!loader) return;
    const items = await loader.list({ childId, sourceOrgIds: [orgA] });
    expect(items).toEqual([expect.objectContaining({ id: childId, sourceOrgId: orgA, title: "Health profile" })]);
    expect(await loader.list({ childId, sourceOrgIds: [] })).toEqual([]);
    expect(await loader.list({ childId: otherChild, sourceOrgIds: [orgA] })).toEqual([]);
    const item = await loader.get({ childId, sourceOrgIds: [orgA] }, childId);
    expect(item?.body).toMatchObject({ kind: "markdown" });
    expect(item?.body.kind === "markdown" && item.body.markdown).toContain("**Peanut** - Severe - hives");
    expect(await loader.get({ childId, sourceOrgIds: [orgA] }, otherChild)).toBeNull();
    expect(await loader.get({ childId, sourceOrgIds: [] }, childId)).toBeNull();
    expect(await loader.get({ childId, sourceOrgIds: [orgA] }, "nope")).toBeNull();
  });

  it("the save function refuses a guardian whose link was revoked (defence in depth)", async () => {
    await sql`update guardian_links set status = 'revoked', revoked_at = now() where child_id = ${childId} and user_id = ${guardianA.id}`;
    const { saveHealthProfile } = await import("@/lib/queries/health");
    const fields = HealthProfilePutSchema.parse({ version: 4 });
    const { version, ...rest } = fields;
    expect(await saveHealthProfile(childId, guardianA.id, rest, version)).toEqual({ result: "not_found" });
    as(guardianA);
    expect((await getFamily()).status).toBe(404);
  });
});
