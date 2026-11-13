// Ticket 041 FR-1 - FR-4, NFR-2: the audit log is append-only for every role, attributed from the session, survives case
// deletion; every security-critical action in lib/audit/strict-actions.ts fails closed (static check of every entry +
// runtime forced audit failures -> 503 and no state change); the dev hook AUDIT_FAIL_ACTIONS (E-2); log redaction.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { loadEnvConfig } from "@next/env";
import postgres, { type Sql } from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { STRICT_ACTIONS } from "@/lib/audit/strict-actions";
import { redact } from "@/lib/log";
import { createWorld, ctx, post, type TestUser } from "./helpers/world";

loadEnvConfig(process.cwd(), false, { info: () => {}, error: () => {} });
const enabled = Boolean(process.env.DATABASE_URL) && process.env.SKIP_DB_TESTS !== "1";
const ROOT = process.cwd();
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const session = vi.hoisted(() => ({ user: null as null | { id: string; email: string } }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getAuthenticatedUser: vi.fn(async () => session.user) };
});

describe("strict actions are implemented fail-closed (static, FR-2)", () => {
  it.each(STRICT_ACTIONS.map((a) => [a.action, a] as const))("%s", (_action, entry) => {
    expect(entry.routes.length).toBeGreaterThan(0);
    for (const route of entry.routes) {
      expect(existsSync(path.join(ROOT, route)), route).toBe(true);
      expect(read(route), `${route} calls ${entry.call}`).toMatch(new RegExp(`\\b${entry.call}\\(`));
    }
    const source = read(entry.impl.module);
    expect(source, `${entry.impl.module} defines ${entry.call}`).toMatch(new RegExp(`export (async )?function ${entry.call}\\b`));
    if (entry.impl.kind === "auditStrict") {
      // The function body that performs the change writes the audit row with auditStrict inside its transaction.
      const start = source.search(new RegExp(`export (async )?function ${entry.call}\\b`));
      const next = source.slice(start + 10).search(/\nexport /);
      const body = next === -1 ? source.slice(start) : source.slice(start, start + 10 + next);
      expect(body, `${entry.call} uses auditStrict`).toMatch(/auditStrict\(/);
      expect(body, `${entry.call} uses a transaction`).toMatch(/\.begin\(/);
      expect(body, `${entry.call} audits ${entry.action}`).toContain(`"${entry.action}"`);
    } else {
      const migration = read(entry.impl.migration);
      const fnStart = migration.indexOf(`function public.${entry.impl.fn}(`);
      expect(fnStart, `${entry.impl.fn} defined in ${entry.impl.migration}`).toBeGreaterThan(-1);
      const fnBody = migration.slice(fnStart, migration.indexOf("$$;", migration.indexOf("$$", fnStart) + 2));
      expect(fnBody, `${entry.impl.fn} writes its audit row`).toContain("insert into public.audit_events");
      expect(source, `${entry.impl.module} calls ${entry.impl.fn}`).toContain(`"${entry.impl.fn}"`);
      expect(source, `${entry.impl.module} honours AUDIT_FAIL_ACTIONS`).toMatch(/auditWouldFail\(|assertAuditWritable\(/);
    }
  });

  it("covers the FR-2 list", () => {
    const actions = STRICT_ACTIONS.map((a) => a.action);
    for (const required of [
      "consent.granted",
      "consent.withdrawn",
      "sharing.granted",
      "sharing.revoked",
      "document.downloaded",
      "document.deleted",
      "org.invitation_created",
      "org.member_revoked",
      "guardian.left_child",
      "guardian.link_revoked",
      "privacy.export_requested",
      "privacy.deletion_requested",
      "privacy.deletion_reviewed",
    ]) {
      expect(actions).toContain(required);
    }
  });
});

describe("log redaction (NFR-2)", () => {
  it("masks emails, phones (last 4 kept) and tokens; keeps ids, dates and counts", () => {
    const line = redact(
      "user acct-guardian-a@example.test +91 90000 00001 9000000002 token jaXbMNzhFw9ezlj33HQ5sxryiTb8sojfIZaFt6pcDt4 " +
        "Bearer abc.def https://x/sign?token=abcd id 00000000-0000-4000-8000-00000000a001 at 2026-11-13 02:14 count=42",
    );
    expect(line).not.toMatch(/example\.test|90000 00001|9000000002|jaXbMN|abc\.def|token=abcd/);
    expect(line).toContain("***0001");
    expect(line).toContain("***0002");
    expect(line).toContain("00000000-0000-4000-8000-00000000a001");
    expect(line).toContain("2026-11-13 02:14");
    expect(line).toContain("count=42");
  });
});

describe.skipIf(!enabled)("audit hardening (database)", { timeout: 120_000 }, () => {
  let sql: Sql;
  let db: ReturnType<typeof import("@/lib/db").supabaseAdmin>;
  let world: ReturnType<typeof createWorld>;
  let owner: TestUser, member: TestUser, invitee: TestUser, guardian: TestUser, admin: TestUser;
  let orgA: string;
  let kase: Awaited<ReturnType<ReturnType<typeof createWorld>["kase"]>>;
  let linkId: string;
  const triggers: string[] = [];
  const as = (u: TestUser | null) => {
    session.user = u;
  };

  /** Makes the audit insert of `action` by `actor` fail (only for this test's user, so parallel suites are unaffected). */
  async function failAudit(action: string, actorId: string) {
    const fn = `t041_fail_${randomUUID().slice(0, 8)}`;
    triggers.push(fn);
    await sql.unsafe(`
      create function public.${fn}() returns trigger language plpgsql as $f$
      begin raise exception 'forced audit failure (test)'; end $f$;
      create trigger ${fn} before insert on public.audit_events for each row
      when (new.action = '${action}' and new.actor_user_id = '${actorId}') execute function public.${fn}();`);
    return async () => {
      await sql.unsafe(`drop trigger if exists ${fn} on public.audit_events; drop function if exists public.${fn}();`);
    };
  }

  beforeAll(async () => {
    sql = postgres(process.env.DATABASE_URL as string, { max: 4, prepare: false, onnotice: () => {} });
    db = (await import("@/lib/db")).supabaseAdmin();
    world = createWorld(sql, db, "t041a");
    owner = await world.user("owner", "provider");
    member = await world.user("member", "provider");
    invitee = await world.user("invitee", "provider");
    guardian = await world.user("guardian", "guardian", { phoneVerified: true });
    admin = await world.user("admin", "platform_admin");
    orgA = await world.org(owner, "Centre A");
    await world.member(orgA, member);
    kase = await world.kase(orgA);
    linkId = await world.link(kase.childId, guardian);
  });

  afterAll(async () => {
    as(null);
    vi.unstubAllEnvs();
    for (const fn of triggers) await sql?.unsafe(`drop trigger if exists ${fn} on public.audit_events; drop function if exists public.${fn}();`);
    if (sql && kase) {
      await sql`delete from deletion_requests where child_id = ${kase.childId}`;
      const paths = await sql<{ storage_path: string }[]>`select storage_path from privacy_exports where child_id = ${kase.childId} and storage_path is not null`;
      if (paths.length) await db.storage.from("exports").remove(paths.map((p) => p.storage_path));
      await sql`delete from privacy_exports where child_id = ${kase.childId}`;
      await sql`delete from org_invitations where org_id = ${orgA}`;
    }
    await world?.cleanup();
    await sql?.end({ timeout: 5 });
  });

  beforeEach(() => as(null));
  afterEach(() => vi.unstubAllEnvs());

  it("FR-1: update/delete/truncate on audit_events raise for every role (incl. the owner)", async () => {
    const { audit } = await import("@/lib/audit");
    await audit({ actor: "system", action: "t041.append_only", entityId: kase.caseId });
    const [row] = await sql<{ id: string }[]>`select id::text as id from audit_events where action = 't041.append_only' and entity_id = ${kase.caseId}`;
    for (const role of ["anon", "authenticated", "service_role"]) {
      for (const stmt of [
        `update public.audit_events set action = 'x' where id = ${row.id}`,
        `delete from public.audit_events where id = ${row.id}`,
        `truncate public.audit_events`,
      ]) {
        await expect(
          sql.begin(async (tx) => {
            await tx.unsafe(`set local role ${role}`);
            await tx.unsafe(stmt);
          }),
          `${role}: ${stmt}`,
        ).rejects.toThrow(/permission denied/);
      }
    }
    await expect(sql`update audit_events set action = 'x' where id = ${row.id}`).rejects.toThrow(/append-only/);
    await expect(sql`delete from audit_events where id = ${row.id}`).rejects.toThrow(/append-only/);
    await expect(sql.begin((tx) => tx.unsafe("truncate public.audit_events"))).rejects.toThrow(/append-only/);
    // The maintenance flag does not lift the truncate ban.
    await expect(
      sql.begin(async (tx) => {
        await tx`select set_config('dnm.audit_maintenance', 'on', true)`;
        await tx.unsafe("truncate public.audit_events");
      }),
    ).rejects.toThrow(/append-only/);
    const [still] = await sql`select action from audit_events where id = ${row.id}`;
    expect(still.action).toBe("t041.append_only");
    // service_role may still insert and read (the app's writer).
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe("set local role service_role");
        await tx`insert into public.audit_events (actor, action) values ('system', 't041.service_insert')`;
        await tx`select 1 from public.audit_events where action = 't041.service_insert'`;
      }),
    ).resolves.toBeUndefined();
  });

  it("FR-1/FR-3: rows are attributed and survive case deletion (case_ref, child, org kept)", async () => {
    const extra = await world.kase(orgA);
    const { audit } = await import("@/lib/audit");
    as(owner);
    await audit({ caseId: extra.caseId, action: "t041.attributed", entity: "case", entityId: extra.caseId });
    await sql`insert into audit_events (case_id, actor, action) values (${extra.caseId}, 'ai', 't041.legacy_writer')`;
    await sql`delete from cases where id = ${extra.caseId}`;
    const rows = await sql`
      select action, actor, actor_user_id, actor_role, case_id, case_ref, child_id, org_id from audit_events
      where case_ref = ${extra.caseId} and action like 't041.%' order by id`;
    expect(rows).toEqual([
      { action: "t041.attributed", actor: "provider", actor_user_id: owner.id, actor_role: "provider", case_id: extra.caseId, case_ref: extra.caseId, child_id: extra.childId, org_id: orgA },
      { action: "t041.legacy_writer", actor: "ai", actor_user_id: null, actor_role: "ai", case_id: extra.caseId, case_ref: extra.caseId, child_id: extra.childId, org_id: orgA },
    ]);
  });

  it("E-1 step 2: confirming a fact is attributed to the signed-in provider", async () => {
    const [fact] = await sql<{ id: string }[]>`
      insert into facts (case_id, recording_id, instrument, item_id, value, ai_value, source, status)
      values (${kase.caseId}, ${kase.recordingId}, 'ISAA', '7', '3'::jsonb, '3'::jsonb, 'session', 'suggested') returning id`;
    as(owner);
    const route = await import("@/app/api/facts/[id]/route");
    const res = await route.PATCH(post("http://localhost/x", { action: "confirm", actor: "ai", actor_user_id: admin.id }, "PATCH"), ctx({ id: fact.id }));
    expect(res.status).toBe(200);
    const [row] = await sql`select actor_user_id, actor_role, child_id, org_id from audit_events where action = 'fact.confirmed' and entity_id = ${fact.id}`;
    expect(row).toEqual({ actor_user_id: owner.id, actor_role: "provider", child_id: kase.childId, org_id: orgA });
  });

  it("FR-2 runtime: forced audit failure -> 503 and no state change (017 invitations and membership)", async () => {
    as(owner);
    const invitations = await import("@/app/api/orgs/[id]/invitations/route");
    let undo = await failAudit("org.invitation_created", owner.id);
    const res = await invitations.POST(post("http://localhost/x", { email: invitee.email, org_role: "member" }), ctx({ id: orgA }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Could not save. Please try again." });
    await undo();
    expect(await sql`select 1 from org_invitations where org_id = ${orgA}`).toHaveLength(0);

    const created = await invitations.POST(post("http://localhost/x", { email: invitee.email, org_role: "member" }), ctx({ id: orgA }));
    expect(created.status).toBe(201);
    const token = new URL(((await created.json()) as { url: string }).url).pathname.split("/").pop() as string;
    const [inv] = await sql<{ id: string }[]>`select id from org_invitations where org_id = ${orgA}`;

    as(invitee);
    const accept = await import("@/app/api/invitations/accept/route");
    undo = await failAudit("org.invitation_accepted", invitee.id);
    expect((await accept.POST(post("http://localhost/x", { token }))).status).toBe(503);
    await undo();
    expect(await sql`select 1 from org_members where org_id = ${orgA} and user_id = ${invitee.id}`).toHaveLength(0);
    expect((await sql`select accepted_at from org_invitations where id = ${inv.id}`)[0].accepted_at).toBeNull();

    as(owner);
    const revokeInvite = await import("@/app/api/orgs/[id]/invitations/[invitationId]/route");
    undo = await failAudit("org.invitation_revoked", owner.id);
    expect((await revokeInvite.DELETE(new Request("http://localhost/x"), ctx({ id: orgA, invitationId: inv.id }))).status).toBe(503);
    await undo();
    expect((await sql`select revoked_at from org_invitations where id = ${inv.id}`)[0].revoked_at).toBeNull();
    expect((await revokeInvite.DELETE(new Request("http://localhost/x"), ctx({ id: orgA, invitationId: inv.id }))).status).toBe(200);
    const [revokedAudit] = await sql`select actor_user_id, actor_role, org_id from audit_events where action = 'org.invitation_revoked' and entity_id = ${inv.id}`;
    expect(revokedAudit).toEqual({ actor_user_id: owner.id, actor_role: "provider", org_id: orgA });

    const members = await import("@/app/api/orgs/[id]/members/[userId]/route");
    undo = await failAudit("org.member_revoked", owner.id);
    expect((await members.DELETE(new Request("http://localhost/x"), ctx({ id: orgA, userId: member.id }))).status).toBe(503);
    await undo();
    expect((await sql`select status from org_members where org_id = ${orgA} and user_id = ${member.id}`)[0].status).toBe("active");
  });

  it("FR-2 runtime: guardian link changes fail closed (leave, admin revoke)", async () => {
    as(guardian);
    const leave = await import("@/app/api/family/children/[id]/leave/route");
    let undo = await failAudit("guardian.left_child", guardian.id);
    expect((await leave.POST(post("http://localhost/x"), ctx({ id: kase.childId }))).status).toBe(503);
    await undo();
    expect((await sql`select status from guardian_links where id = ${linkId}`)[0].status).toBe("active");

    as(admin);
    const revoke = await import("@/app/api/admin/guardian-links/[id]/revoke/route");
    undo = await failAudit("guardian.link_revoked", admin.id);
    expect((await revoke.POST(post("http://localhost/x"), ctx({ id: linkId }))).status).toBe(503);
    await undo();
    expect((await sql`select status from guardian_links where id = ${linkId}`)[0].status).toBe("active");
  });

  it("FR-2 runtime: consent (SQL function) fails closed; E-2 AUDIT_FAIL_ACTIONS hook -> 503, then works", async () => {
    as(guardian);
    const consents = await import("@/app/api/family/children/[id]/consents/route");
    const [doc] = await sql<{ id: string }[]>`
      select id from consent_documents where feature = 'ai_follow_up' and locale = 'en' order by version desc limit 1`;
    const body = { feature: "ai_follow_up", consent_document_id: doc.id, agree: true };
    const undo = await failAudit("consent.granted", guardian.id);
    expect((await consents.POST(post("http://localhost/x", body), ctx({ id: kase.childId }))).status).toBe(503);
    await undo();
    vi.stubEnv("AUDIT_FAIL_ACTIONS", "consent.granted");
    const hooked = await consents.POST(post("http://localhost/x", body), ctx({ id: kase.childId }));
    expect(hooked.status).toBe(503);
    expect(await hooked.json()).toEqual({ error: "Could not save. Please try again." });
    expect(await sql`select 1 from consent_records where child_id = ${kase.childId} and feature = 'ai_follow_up'`).toHaveLength(0);
    vi.unstubAllEnvs();
    expect((await consents.POST(post("http://localhost/x", body), ctx({ id: kase.childId }))).status).toBe(201);
    expect(await sql`select 1 from consent_records where child_id = ${kase.childId} and feature = 'ai_follow_up'`).toHaveLength(1);
  });

  it("FR-2 runtime: export and deletion requests and reviews fail closed", async () => {
    as(guardian);
    const exportsRoute = await import("@/app/api/family/children/[id]/exports/route");
    let undo = await failAudit("privacy.export_requested", guardian.id);
    expect((await exportsRoute.POST(post("http://localhost/x"), ctx({ id: kase.childId }))).status).toBe(503);
    await undo();
    expect(await sql`select 1 from privacy_exports where child_id = ${kase.childId}`).toHaveLength(0);

    const created = await exportsRoute.POST(post("http://localhost/x"), ctx({ id: kase.childId }));
    expect(created.status).toBe(202);
    const exportId = ((await created.json()) as { export_id: string }).export_id;
    const { runPrivacyJobs } = await import("@/lib/privacy/jobs");
    await runPrivacyJobs({ exportIds: [exportId], deletionIds: [] });
    const download = await import("@/app/api/family/exports/[id]/download/route");
    undo = await failAudit("privacy.export_downloaded", guardian.id);
    expect((await download.GET(new Request("http://localhost/x"), ctx({ id: exportId }))).status).toBe(503);
    await undo();
    expect((await sql`select downloaded_at from privacy_exports where id = ${exportId}`)[0].downloaded_at).toBeNull();

    const deletion = await import("@/app/api/family/children/[id]/deletion-requests/route");
    undo = await failAudit("privacy.deletion_requested", guardian.id);
    expect((await deletion.POST(post("http://localhost/x", { scope: "everything" }), ctx({ id: kase.childId }))).status).toBe(503);
    await undo();
    expect(await sql`select 1 from deletion_requests where child_id = ${kase.childId}`).toHaveLength(0);
    expect(await sql`select 1 from outbox_events where topic = 'privacy.deletion_requested' and payload ->> 'child_id' = ${kase.childId}`).toHaveLength(0);

    const ok = await deletion.POST(post("http://localhost/x", { scope: "everything" }), ctx({ id: kase.childId }));
    expect(ok.status).toBe(201);
    const requestId = ((await ok.json()) as { request: { id: string } }).request.id;
    as(admin);
    const review = await import("@/app/api/admin/privacy/requests/[id]/route");
    undo = await failAudit("privacy.deletion_reviewed", admin.id);
    expect((await review.POST(post("http://localhost/x", { decision: "approve" }), ctx({ id: requestId }))).status).toBe(503);
    await undo();
    expect((await sql`select status from deletion_requests where id = ${requestId}`)[0].status).toBe("requested");
  });

  it("FR-4: audit query filters (action, actor, child, case) and keyset pages; no details column", async () => {
    const { listAuditEvents, cleanFilters } = await import("@/lib/audit/query");
    expect(cleanFilters({ action: "x'; drop table", actor: "nobody", child: "not-a-uuid", from: "2026-13" })).toEqual({});
    const byChild = await listAuditEvents(cleanFilters({ child: kase.childId }));
    expect(byChild.rows.length).toBeGreaterThan(0);
    expect(byChild.rows.every((r) => r.child_id === kase.childId)).toBe(true);
    expect(Object.keys(byChild.rows[0])).not.toContain("details");
    const byAction = await listAuditEvents(cleanFilters({ action: "privacy.*", actor: guardian.id }));
    expect(byAction.rows.map((r) => r.action)).toEqual(expect.arrayContaining(["privacy.export_requested", "privacy.deletion_requested"]));
    expect(byAction.rows.every((r) => r.actor_user_id === guardian.id && r.action.startsWith("privacy."))).toBe(true);
    const byRole = await listAuditEvents(cleanFilters({ actor: "platform_admin", case: kase.caseId }));
    expect(byRole.rows.every((r) => r.actor_role === "platform_admin" && r.case_ref === kase.caseId)).toBe(true);
  });
});
