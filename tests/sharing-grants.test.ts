// Ticket 022 FR-2/FR-4/FR-5/FR-6/FR-7: guardian sharing grants and requireSharedAccess (grant states none,
// active, wrong scope, expired, revoked), the `reports` share loader (final reports only), `sharing.viewed`
// auditing, strict audit on grant writes, and RLS. Needs the local Supabase stack (DATABASE_URL).
// Synthetic data only; everything is removed afterwards.
import { randomUUID } from "node:crypto";
import { loadEnvConfig } from "@next/env";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sharingErrorKey } from "@/components/family/children/SharingPanel";
import { GrantCreateSchema } from "@/lib/sharing/grants";
import { reportTitle } from "@/lib/sharing/loaders/reports";
import { SHARE_LOADERS } from "@/lib/sharing/registry";
import { createWorld, ctx, post, type TestUser } from "./helpers/world";

loadEnvConfig(process.cwd(), false, { info: () => {}, error: () => {} });
const enabled = Boolean(process.env.DATABASE_URL) && process.env.SKIP_DB_TESTS !== "1";

const session = vi.hoisted(() => ({ user: null as null | { id: string; email: string } }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getAuthenticatedUser: vi.fn(async () => session.user) };
});

const notify = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock("@/lib/notify/topics", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/notify/topics")>();
  return { ...actual, notifyLater: vi.fn(async (...args: unknown[]) => void notify.calls.push(args)) };
});

describe("grant request validation and helpers", () => {
  const base = { source_org_id: randomUUID(), grantee_org_id: randomUUID(), scopes: ["reports"] };

  it("accepts 90, 365 or no expiry and known scopes only", () => {
    expect(GrantCreateSchema.parse(base).expires_in_days).toBeNull();
    expect(GrantCreateSchema.parse({ ...base, expires_in_days: 90 }).expires_in_days).toBe(90);
    expect(GrantCreateSchema.parse({ ...base, expires_in_days: null }).expires_in_days).toBeNull();
    expect(GrantCreateSchema.safeParse({ ...base, expires_in_days: 30 }).success).toBe(false);
    expect(GrantCreateSchema.safeParse({ ...base, scopes: [] }).success).toBe(false);
    expect(GrantCreateSchema.safeParse({ ...base, scopes: ["everything"] }).success).toBe(false);
    expect(GrantCreateSchema.safeParse({ ...base, source_org_id: "x" }).success).toBe(false);
  });

  it("registers the reports loader; other scopes register in their own tickets", () => {
    expect(Object.keys(SHARE_LOADERS)).toEqual(expect.arrayContaining(["reports", "health_profile"]));
    expect(reportTitle("# Assessment summary\n\ntext")).toBe("Assessment summary");
    expect(reportTitle("no heading")).toBe("Assessment report");
  });

  it("maps API statuses to translated guardian messages", () => {
    expect(sharingErrorKey(422)).toBe("notTreating");
    expect(sharingErrorKey(503)).toBe("saveFailed");
  });
});

describe.skipIf(!enabled)("sharing grants (database)", { timeout: 90_000 }, () => {
  let sql: Sql;
  let world: ReturnType<typeof createWorld>;
  let authz: typeof import("@/lib/authz");
  let shared: typeof import("@/lib/sharing/shared");
  let ownerA: TestUser, providerA: TestUser, providerB: TestUser, memberB: TestUser, ownerC: TestUser;
  let guardianA: TestUser, guardianB: TestUser;
  let orgA: string, orgB: string, orgC: string;
  let childId: string, caseA: string, caseB: string, finalReport: string, draftReport: string;

  const as = (u: TestUser | null) => {
    session.user = u;
  };

  const routes = async () => ({
    grants: await import("@/app/api/family/children/[id]/sharing-grants/route"),
    revoke: await import("@/app/api/family/children/[id]/sharing-grants/[grantId]/revoke/route"),
  });

  async function share(body: Record<string, unknown>, child = childId) {
    const { grants } = await routes();
    return grants.POST(post("http://localhost/x", body), ctx({ id: child }));
  }

  async function revoke(grantId: string, child = childId) {
    const { revoke: r } = await routes();
    return r.POST(post("http://localhost/x"), ctx({ id: child, grantId }));
  }

  async function sharedStatus(user: TestUser, scope: "reports" | "documents" = "reports") {
    as(user);
    const result = await authz.requireSharedAccess(childId, scope);
    return result instanceof Response ? result.status : result.sourceOrgIds;
  }

  const kaseB = () => ({ id: caseB, org_id: orgB, child_id: childId });

  beforeAll(async () => {
    sql = postgres(process.env.DATABASE_URL as string, { max: 4, prepare: false, onnotice: () => {} });
    const db = (await import("@/lib/db")).supabaseAdmin();
    authz = await import("@/lib/authz");
    shared = await import("@/lib/sharing/shared");
    world = createWorld(sql, db, "t022s");
    ownerA = await world.user("owner-a", "provider");
    providerA = await world.user("provider-a", "provider");
    providerB = await world.user("provider-b", "provider");
    memberB = await world.user("member-b", "provider");
    ownerC = await world.user("owner-c", "provider");
    guardianA = await world.user("guardian-a", "guardian", { phoneVerified: true });
    guardianB = await world.user("guardian-b", "guardian", { phoneVerified: true });
    orgA = await world.org(ownerA, "Centre A");
    orgB = await world.org(providerB, "Solo B");
    orgC = await world.org(ownerC, "Centre C");
    await world.member(orgA, providerA);
    await world.member(orgB, memberB);

    const a = await world.kase(orgA);
    ({ caseId: caseA, childId, reportId: finalReport } = a);
    ({ caseId: caseB } = await world.kase(orgB, { childId }));
    await world.kase(orgC); // org C treats another child only
    await world.link(childId, guardianA);
    await sql`update reports set content_md = '# Assessment summary (synthetic)' where id = ${finalReport}`;
    const [rec] = await sql<{ id: string }[]>`
      insert into recordings (case_id, kind, session_number, status) values (${caseA}, 'session', 2, 'extracted') returning id`;
    [{ id: draftReport }] = await sql<{ id: string }[]>`
      insert into reports (case_id, recording_id, kind, content, content_md, status)
      values (${caseA}, ${rec.id}, 'assessment', '{}'::jsonb, '# Draft (synthetic)', 'draft') returning id`;
  });

  afterAll(async () => {
    await world?.cleanup();
    await sql?.end({ timeout: 5 });
  });

  beforeEach(() => as(null));

  it("E-4: only a linked guardian may share (other guardian 404, provider 403, anonymous 401)", async () => {
    const body = { source_org_id: orgA, grantee_org_id: orgB, scopes: ["reports"] };
    expect((await share(body)).status).toBe(401);
    as(guardianB);
    const other = await share(body);
    expect(other.status).toBe(404);
    expect(await other.json()).toEqual({ error: "Child not found" });
    as(providerA);
    expect((await share(body)).status).toBe(403);
    expect(await sql`select 1 from sharing_grants where child_id = ${childId}`).toHaveLength(0);
  });

  it("E-2.3: org without a case for the child -> 422, same org -> 400", async () => {
    as(guardianA);
    const res = await share({ source_org_id: orgA, grantee_org_id: orgC, scopes: ["reports"] });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "This organisation is not treating your child" });
    expect((await share({ source_org_id: orgC, grantee_org_id: orgB, scopes: ["reports"] })).status).toBe(422);
    expect((await share({ source_org_id: orgA, grantee_org_id: orgA, scopes: ["reports"] })).status).toBe(400);
    expect((await share({ source_org_id: orgA, grantee_org_id: orgB, scopes: [] })).status).toBe(400);
  });

  it("strict audit: a forced audit failure -> 503 and no grant", async () => {
    const fn = `t022_fail_audit_${childId.slice(0, 8)}`;
    await sql.unsafe(`
      create function public.${fn}() returns trigger language plpgsql as $f$
      begin raise exception 'forced audit failure (test)'; end $f$;
      create trigger ${fn} before insert on public.audit_events for each row
      when (new.action like 'sharing.%' and new.details ->> 'child_id' = '${childId}') execute function public.${fn}();`);
    try {
      as(guardianA);
      const res = await share({ source_org_id: orgA, grantee_org_id: orgB, scopes: ["reports"] });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "Could not save. Please try again." });
    } finally {
      await sql.unsafe(`drop trigger if exists ${fn} on public.audit_events; drop function if exists public.${fn}();`);
    }
    expect(await sql`select 1 from sharing_grants where child_id = ${childId}`).toHaveLength(0);
  });

  it("grant states x requireSharedAccess: none, active, wrong scope, expired, revoked", async () => {
    // none
    expect(await sharedStatus(providerB)).toBe(404);
    expect(await shared.listSharedForCase(providerB.id, kaseB())).toEqual([]);

    // active: org A -> org B, reports only, 3 months (E-2.2)
    as(guardianA);
    notify.calls = [];
    const res = await share({ source_org_id: orgA, grantee_org_id: orgB, scopes: ["reports"], expires_in_days: 90 });
    expect(res.status).toBe(201);
    const { grant } = await res.json();
    expect(grant).toMatchObject({ child_id: childId, source_org_id: orgA, grantee_org_id: orgB, scopes: ["reports"], granted_by: guardianA.id });
    const days = (new Date(grant.expires_at).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(89.9);
    expect(days).toBeLessThan(90.1);
    const [granted] = await sql<{ actor: string; actor_user_id: string; details: Record<string, unknown> }[]>`
      select actor, actor_user_id, details from audit_events where action = 'sharing.granted' and entity_id = ${grant.id}`;
    expect(granted).toMatchObject({ actor: "parent", actor_user_id: guardianA.id });
    expect(granted.details).toMatchObject({ source_org_id: orgA, grantee_org_id: orgB, scopes: ["reports"] });
    expect(notify.calls).toEqual([["sharing.granted", { grant_id: grant.id, source_org_id: orgA, grantee_org_id: orgB }]]);

    expect(await sharedStatus(providerB)).toEqual([orgA]);
    // Unassigned member of the grantee org, the source org's own providers and other guardians: no shared access.
    expect(await sharedStatus(memberB)).toBe(404);
    expect(await sharedStatus(providerA)).toBe(404);
    expect(await sharedStatus(ownerC)).toBe(404);
    as(guardianA);
    expect(((await authz.requireSharedAccess(childId, "reports")) as Response).status).toBe(403);

    // wrong scope (E-3.2)
    expect(await sharedStatus(providerB, "documents")).toBe(404);

    // E-3.1: only the finalised report is listed; opening it audits sharing.viewed
    const sources = await shared.listSharedForCase(providerB.id, kaseB());
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ sourceOrgId: orgA, expiresAt: grant.expires_at });
    expect(sources[0].sourceOrgName).toContain("Centre A");
    expect(sources[0].scopes).toEqual([
      { scope: "reports", available: true, items: [expect.objectContaining({ id: finalReport, title: "Assessment summary (synthetic)", sourceOrgId: orgA })] },
    ]);
    expect(await shared.openSharedItem(providerB.id, kaseB(), "reports", draftReport)).toBeNull();
    expect(await shared.openSharedItem(providerB.id, kaseB(), "documents", finalReport)).toBeNull();
    expect(await shared.openSharedItem(memberB.id, kaseB(), "reports", finalReport)).toBeNull();
    const opened = await shared.openSharedItem(providerB.id, kaseB(), "reports", finalReport);
    expect(opened?.item.body).toEqual({ kind: "markdown", markdown: "# Assessment summary (synthetic)" });
    const viewed = await sql<{ case_id: string; actor_user_id: string; details: Record<string, unknown> }[]>`
      select case_id, actor_user_id, details from audit_events where action = 'sharing.viewed' and entity_id = ${grant.id}`;
    expect(viewed).toHaveLength(1);
    expect(viewed[0]).toMatchObject({ case_id: caseB, actor_user_id: providerB.id });
    expect(viewed[0].details).toMatchObject({ grant_id: grant.id, scope: "reports", item_id: finalReport });
    // Read only: the grant never opens org A's case itself.
    as(providerB);
    expect((await authz.requireCaseAccess(caseA))?.status).toBe(404);

    // expired (E-3.3)
    await sql`update sharing_grants set created_at = now() - interval '2 days', expires_at = now() - interval '1 second' where id = ${grant.id}`;
    expect(await sharedStatus(providerB)).toBe(404);
    expect(await shared.openSharedItem(providerB.id, kaseB(), "reports", finalReport)).toBeNull();
    expect(await shared.listSharedForCase(providerB.id, kaseB())).toEqual([]);
    as(guardianA);
    const list = await (await routes()).grants.GET(post("http://localhost/x", undefined, "GET"), ctx({ id: childId }));
    expect((await list.json()).grants).toEqual([]);

    // revoked (E-3.4)
    const again = await share({ source_org_id: orgA, grantee_org_id: orgB, scopes: ["reports", "documents"] });
    expect(again.status).toBe(201);
    const second = (await again.json()).grant;
    expect(second.expires_at).toBeNull();
    expect(await sharedStatus(providerB)).toEqual([orgA]);
    expect(await sharedStatus(providerB, "documents")).toEqual([orgA]);
    as(guardianB);
    expect((await revoke(second.id)).status).toBe(404);
    as(guardianA);
    expect((await revoke(randomUUID())).status).toBe(404);
    const stopped = await revoke(second.id);
    expect(stopped.status).toBe(200);
    expect((await stopped.json()).grant.revoked_by).toBe(guardianA.id);
    expect(await sharedStatus(providerB)).toBe(404);
    as(guardianA);
    expect((await revoke(second.id)).status).toBe(404);
    const [revoked] = await sql<{ actor_user_id: string }[]>`
      select actor_user_id from audit_events where action = 'sharing.revoked' and entity_id = ${second.id}`;
    expect(revoked.actor_user_id).toBe(guardianA.id);
  });

  it("a new grant for the same pair replaces the old one; a removed assignment or departed guardian ends access", async () => {
    as(guardianA);
    const first = (await (await share({ source_org_id: orgB, grantee_org_id: orgA, scopes: ["reports"] })).json()).grant;
    const second = (await (await share({ source_org_id: orgB, grantee_org_id: orgA, scopes: ["iep"], expires_in_days: 365 })).json()).grant;
    const rows = await sql<{ id: string; revoked_at: Date | null }[]>`
      select id, revoked_at from sharing_grants where id in (${first.id}, ${second.id}) order by created_at`;
    expect(rows.map((r) => r.revoked_at !== null)).toEqual([true, false]);
    const [replaced] = await sql<{ details: { reason: string } }[]>`
      select details from audit_events where action = 'sharing.revoked' and entity_id = ${first.id}`;
    expect(replaced.details.reason).toBe("replaced");

    // providerA is a plain member of org A: access only while assigned to org A's case.
    expect(await sharedStatus(providerA, "reports")).toBe(404);
    as(providerA);
    expect(((await authz.requireSharedAccess(childId, "iep")) as Response).status).toBe(404);
    const [assignment] = await sql<{ id: string }[]>`
      insert into case_assignments (case_id, user_id) values (${caseA}, ${providerA.id}) returning id`;
    const ok = await authz.requireSharedAccess(childId, "iep");
    expect(ok instanceof Response ? ok.status : ok.sourceOrgIds).toEqual([orgB]);
    // iep has no loader yet: listed as shared but not available.
    const sources = await shared.listSharedForCase(providerA.id, { id: caseA, org_id: orgA, child_id: childId });
    expect(sources[0].scopes).toEqual([{ scope: "iep", available: false, items: [] }]);
    await sql`update case_assignments set removed_at = now() where id = ${assignment.id}`;
    expect(((await authz.requireSharedAccess(childId, "iep")) as Response).status).toBe(404);
    await sql`update case_assignments set removed_at = null where id = ${assignment.id}`;

    // The granting guardian leaves the child: the grant stops counting (fail closed).
    await sql`update guardian_links set status = 'revoked', revoked_at = now() where child_id = ${childId} and user_id = ${guardianA.id}`;
    expect(((await authz.requireSharedAccess(childId, "iep")) as Response).status).toBe(404);
    await sql`update guardian_links set status = 'active', revoked_at = null where child_id = ${childId} and user_id = ${guardianA.id}`;
    expect(await authz.requireSharedAccess(childId, "iep")).not.toBeInstanceOf(Response);
  });

  it("guardian care team lists every treating organisation and its providers, without emails", async () => {
    const { listChildCareTeam } = await import("@/lib/cases/team");
    await sql`update user_profiles set display_name = 'Dr Synthetic B' where id = ${providerB.id}`;
    const orgs = await listChildCareTeam(childId);
    expect(orgs.map((o) => o.org_id).sort()).toEqual([orgA, orgB].sort());
    const b = orgs.find((o) => o.org_id === orgB)!;
    expect(b.providers).toEqual([
      { user_id: providerB.id, display_name: "Dr Synthetic B", discipline_label: null, provider_type: null, care_role: "lead" },
    ]);
    expect(JSON.stringify(orgs)).not.toContain("@example.test");
  });

  it("RLS: guardians read their children's grants; other guardians and providers read none; no client writes", async () => {
    const count = (userId: string) =>
      sql.begin(async (tx) => {
        await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, role: "authenticated" })}, true)`;
        await tx`set local role authenticated`;
        const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from sharing_grants where child_id = ${childId}`;
        return n;
      });
    expect(await count(guardianA.id)).toBeGreaterThan(0);
    expect(await count(guardianB.id)).toBe(0);
    expect(await count(providerB.id)).toBe(0);
    await expect(
      sql.begin(async (tx) => {
        await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: guardianA.id, role: "authenticated" })}, true)`;
        await tx`set local role authenticated`;
        await tx`update sharing_grants set revoked_at = null where child_id = ${childId}`;
      }),
    ).rejects.toThrow(/permission denied/);
  });
});
