// Ticket 020 FR-12/FR-14/FR-15: parent claim codes (format, hash-only storage, single use, 72 h expiry, older
// codes invalidated, 429 after 5 failures), merging into an existing child, and cross-org isolation.
// Pure helpers always run; the rest needs the local Supabase stack (DATABASE_URL). Synthetic data only.
import { createHash } from "node:crypto";
import { loadEnvConfig } from "@next/env";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ageParts, generateClaimCode, hashClaimCode, normalizeClaimCode } from "@/lib/children/codes";
import { createWorld, ctx, post, type TestUser } from "./helpers/world";

loadEnvConfig(process.cwd(), false, { info: () => {}, error: () => {} });
const enabled = Boolean(process.env.DATABASE_URL) && process.env.SKIP_DB_TESTS !== "1";

const session = vi.hoisted(() => ({ user: null as null | { id: string; email: string } }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getAuthenticatedUser: vi.fn(async () => session.user) };
});

const CODE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/;

describe("claim code helpers", () => {
  it("generates XXXX-XXXX from the unambiguous alphabet (no 0/O/1/I/L)", () => {
    const codes = Array.from({ length: 500 }, generateClaimCode);
    for (const code of codes) expect(code).toMatch(CODE);
    expect(new Set(codes).size).toBeGreaterThan(495);
  });

  it("normalises input and hashes with sha256", () => {
    expect(normalizeClaimCode(" abcd-ef23 ")).toBe("ABCDEF23");
    expect(normalizeClaimCode("ABCD-EF2O")).toBeNull(); // O is not in the alphabet
    expect(normalizeClaimCode("ABC")).toBeNull();
    expect(hashClaimCode("ABCDEF23")).toBe(createHash("sha256").update("claim:ABCDEF23").digest("hex"));
  });

  it("computes age in years and months", () => {
    expect(ageParts("2023-05-01", new Date("2026-11-13T00:00:00Z"))).toEqual({ years: 3, months: 6 });
    expect(ageParts("2026-11-14", new Date("2026-11-13T00:00:00Z"))).toBeNull();
  });
});

describe.skipIf(!enabled)("claim codes and child links (database)", { timeout: 90_000 }, () => {
  let sql: Sql;
  let world: ReturnType<typeof createWorld>;
  let providerA: TestUser, providerB: TestUser, guardianA: TestUser, guardianB: TestUser, guesser: TestUser;
  let orgA: string, orgB: string;
  const as = (u: TestUser | null) => {
    session.user = u;
  };

  const routes = async () => ({
    claimCode: await import("@/app/api/cases/[id]/claim-code/route"),
    claims: await import("@/app/api/family/claims/route"),
    paper: await import("@/app/api/cases/[id]/paper-consents/route"),
    paperWithdraw: await import("@/app/api/cases/[id]/paper-consents/withdraw/route"),
  });

  async function newCode(provider: TestUser, caseId: string) {
    as(provider);
    const res = await (await routes()).claimCode.POST(post("http://localhost/x"), ctx({ id: caseId }));
    expect(res.status).toBe(201);
    return (await res.json()) as { code: string; expires_at: string; whatsapp_url: string };
  }

  async function claim(user: TestUser, code: string, extra: Record<string, unknown> = {}) {
    as(user);
    return (await routes()).claims.POST(post("http://localhost/x", { code, relationship: "father", declaration: true, ...extra }));
  }

  beforeAll(async () => {
    sql = postgres(process.env.DATABASE_URL as string, { max: 4, prepare: false, onnotice: () => {} });
    const db = (await import("@/lib/db")).supabaseAdmin();
    world = createWorld(sql, db, "t020c");
    providerA = await world.user("provider-a", "provider");
    providerB = await world.user("provider-b", "provider");
    guardianA = await world.user("guardian-a", "guardian", { phoneVerified: true });
    guardianB = await world.user("guardian-b", "guardian", { phoneVerified: true });
    guesser = await world.user("guesser", "guardian");
    orgA = await world.org(providerA, "Centre A");
    orgB = await world.org(providerB, "Solo B");
  });

  afterAll(async () => {
    await world?.cleanup();
    await sql?.end({ timeout: 5 });
  });

  beforeEach(() => as(null));

  it("E-3: code is shown once, stored as a hash, expires in 72 h, works once, and the panel sees the link", async () => {
    const c = await world.kase(orgA);
    const created = await newCode(providerA, c.caseId);
    expect(created.code).toMatch(CODE);
    expect(created.whatsapp_url).toMatch(/^https:\/\/wa\.me\//);
    expect(decodeURIComponent(created.whatsapp_url)).toContain(created.code);
    const hours = (Date.parse(created.expires_at) - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(71.9);
    // expires_at comes from the database clock; allow a little skew against the test runner's clock.
    expect(hours).toBeLessThanOrEqual(72.01);
    const rows = await sql`select * from child_claim_codes where case_id = ${c.caseId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].code_hash).toBe(hashClaimCode(normalizeClaimCode(created.code) as string));
    expect(JSON.stringify(rows[0])).not.toContain(created.code.replace("-", ""));
    const [audit] = await sql`select 1 from audit_events where case_id = ${c.caseId} and action = 'child.claim_code_created'`;
    expect(audit).toBeDefined();

    const { countActiveGuardians } = await import("@/lib/children");
    expect(await countActiveGuardians(c.childId)).toBe(0);
    const ok = await claim(guardianB, created.code.toLowerCase());
    expect(ok.status).toBe(201);
    expect(((await ok.json()) as { child: { id: string } }).child.id).toBe(c.childId);
    expect(await countActiveGuardians(c.childId)).toBe(1);
    const [link] = await sql`select verification_method, relationship from guardian_links where child_id = ${c.childId}`;
    expect(link).toEqual({ verification_method: "claim_code", relationship: "father" });
    const [claimed] = await sql`select 1 from audit_events where case_id = ${c.caseId} and action = 'child.claimed'`;
    expect(claimed).toBeDefined();

    const reuse = await claim(guardianA, created.code);
    expect(reuse.status).toBe(404);
    expect(await reuse.json()).toEqual({ error: "This code is not valid" });
    const random = await claim(guardianA, "ZZZZ-2222");
    expect(random.status).toBe(404);
    expect(await random.json()).toEqual({ error: "This code is not valid" });
  });

  it("a new code invalidates the older unused one; expired codes are refused with the same message", async () => {
    const c = await world.kase(orgA);
    const first = await newCode(providerA, c.caseId);
    const second = await newCode(providerA, c.caseId);
    expect((await claim(guardianA, first.code)).status).toBe(404);
    await sql`update child_claim_codes set expires_at = now() - interval '1 second' where case_id = ${c.caseId} and used_at is null`;
    const expired = await claim(guardianA, second.code);
    expect(expired.status).toBe(404);
    expect(await expired.json()).toEqual({ error: "This code is not valid" });
  });

  it("5 failed attempts per user per hour -> 429 (even for a valid code)", async () => {
    const c = await world.kase(orgA);
    const valid = await newCode(providerA, c.caseId);
    for (let i = 0; i < 5; i++) expect((await claim(guesser, `AAAA-AAA${"23456"[i]}`)).status).toBe(404);
    const limited = await claim(guesser, valid.code);
    expect(limited.status).toBe(429);
    await sql`update child_claim_attempts set created_at = now() - interval '61 minutes' where user_id = ${guesser.id}`;
    expect((await claim(guesser, valid.code)).status).toBe(201);
  });

  it("E-5.1: claiming org B's code into an existing child shares one child_id and soft-deletes the placeholder", async () => {
    const a = await world.kase(orgA);
    const codeA = await newCode(providerA, a.caseId);
    expect((await claim(guardianB, codeA.code)).status).toBe(201);

    const b = await world.kase(orgB);
    const codeB = await newCode(providerB, b.caseId);
    const merged = await claim(guardianB, codeB.code, { existing_child_id: a.childId });
    expect(merged.status).toBe(201);
    expect(((await merged.json()) as { child: { id: string } }).child.id).toBe(a.childId);
    const [caseB] = await sql<{ child_id: string }[]>`select child_id from cases where id = ${b.caseId}`;
    expect(caseB.child_id).toBe(a.childId);
    const [placeholder] = await sql<{ deleted_at: Date | null }[]>`select deleted_at from children where id = ${b.childId}`;
    expect(placeholder.deleted_at).not.toBeNull();

    // Rule 2: the shared child never opens org B's case to org A (or the other way round).
    const authz = await import("@/lib/authz");
    as(providerA);
    expect((await authz.requireCaseAccess(b.caseId))?.status).toBe(404);
    expect((await authz.requireRecordingAccess(b.recordingId))?.status).toBe(404);
    expect((await authz.requireReportAccess(b.reportId))?.status).toBe(404);
    expect((await authz.requireChildAccessViaCase(a.childId, b.caseId))?.status).toBe(404);
    expect(await authz.requireChildAccessViaCase(a.childId, a.caseId)).toBeNull();
    const { paper, paperWithdraw, claimCode } = await routes();
    const form = new FormData();
    expect((await paper.POST(new Request("http://localhost/x", { method: "POST", body: form }), ctx({ id: b.caseId }))).status).toBe(404);
    expect(
      (await paperWithdraw.POST(post("http://localhost/x", { feature: "ai_extraction", guardian_name: "X" }), ctx({ id: b.caseId }))).status,
    ).toBe(404);
    expect((await claimCode.POST(post("http://localhost/x"), ctx({ id: b.caseId }))).status).toBe(404);
  });

  it("FR-12: a placeholder with other links or cases cannot be merged (409); the code stays usable", async () => {
    const own = await world.kase(orgA);
    const ownCode = await newCode(providerA, own.caseId);
    expect((await claim(guardianA, ownCode.code)).status).toBe(201);

    const shared = await world.kase(orgB);
    await world.link(shared.childId, guardianB); // already linked to someone else
    const code = await newCode(providerB, shared.caseId);
    const conflict = await claim(guardianA, code.code, { existing_child_id: own.childId });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: "This record is already linked" });
    expect((await claim(guardianA, code.code)).status).toBe(201);

    const notMine = await world.kase(orgB);
    const code2 = await newCode(providerB, notMine.caseId);
    expect((await claim(guardianB, code2.code, { existing_child_id: own.childId })).status).toBe(404);
  });

  it("guardians and anonymous users cannot create codes", async () => {
    const c = await world.kase(orgA);
    const { claimCode } = await routes();
    as(guardianA);
    expect((await claimCode.POST(post("http://localhost/x"), ctx({ id: c.caseId }))).status).toBe(403);
    as(null);
    expect((await claimCode.POST(post("http://localhost/x"), ctx({ id: c.caseId }))).status).toBe(401);
  });
});
