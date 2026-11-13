// Ticket 022 FR-1/FR-2/FR-3/FR-7: case access by role and assignment (the eval access matrix), the care team
// API, the assignment backfill, RLS, and the static "every case/session route is gated" scan. The database
// part needs the local Supabase stack (DATABASE_URL). Synthetic data only; everything is removed afterwards.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { loadEnvConfig } from "@next/env";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { teamErrorKey } from "@/components/case/CareTeamPanel";
import { createWorld, ctx, post, type TestUser } from "./helpers/world";

loadEnvConfig(process.cwd(), false, { info: () => {}, error: () => {} });
const enabled = Boolean(process.env.DATABASE_URL) && process.env.SKIP_DB_TESTS !== "1";

const session = vi.hoisted(() => ({ user: null as null | { id: string; email: string } }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getAuthenticatedUser: vi.fn(async () => session.user) };
});

const ROOT = process.cwd();

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...routeFiles(full));
    else if (entry === "route.ts") out.push(full);
  }
  return out;
}

// Gates that resolve the case and check access (017 requireCaseAccess and stricter wrappers).
const GATE = /await (requireCaseAccess|requireCaseActor|requireRecordingAccess|requireReportAccess|requireFactAccess|requireChildAccessViaCase)\(/;
// Anything that reads case data.
const DB_READ = /supabaseAdmin\(|await (get|list|load|find|fetch)[A-Z]\w*\(/;

// Routes that are not gated by case access on purpose.
const EXEMPT: Record<string, string> = {
  "app/api/cases/route.ts": "POST creates a case: no case id yet; gated by requireProviderApi + org membership",
  "app/api/cases/[id]/ask/route.ts": "012 specialist share link: gated by the referral share token, not a session",
};

describe("every case and session route checks case access before reading data (static scan)", () => {
  const files = [...routeFiles(path.join(ROOT, "app/api/cases")), ...routeFiles(path.join(ROOT, "app/api/sessions"))];

  it("finds the routes", () => {
    expect(files.length).toBeGreaterThanOrEqual(15);
    expect(files.map((f) => path.relative(ROOT, f))).toContain("app/api/cases/[id]/assignments/route.ts");
  });

  it.each(files.map((f) => [path.relative(ROOT, f)]))("%s", (rel) => {
    if (EXEMPT[rel]) return;
    const source = readFileSync(path.join(ROOT, rel), "utf8");
    const handlers = source.split(/export async function (?=GET|POST|PUT|PATCH|DELETE)/).slice(1);
    expect(handlers.length, rel).toBeGreaterThan(0);
    for (const body of handlers) {
      const method = body.slice(0, body.indexOf("("));
      const gate = body.search(GATE);
      const read = body.search(DB_READ);
      expect(gate, `${rel} ${method} has no case gate`).toBeGreaterThan(-1);
      if (read > -1) expect(gate, `${rel} ${method} reads data before the gate`).toBeLessThan(read);
    }
  });
});

describe("care team error messages", () => {
  it("maps API statuses to the translated message keys", () => {
    expect(teamErrorKey("DELETE", 409)).toBe("lastLead");
    expect(teamErrorKey("POST", 422)).toBe("notInOrg");
    expect(teamErrorKey("POST", 409)).toBe("alreadyOnTeam");
    expect(teamErrorKey("PATCH", 403)).toBe("managersOnly");
    expect(teamErrorKey("POST", 500)).toBe("saveFailed");
  });
});

describe.skipIf(!enabled)("case access and care team (database)", { timeout: 90_000 }, () => {
  let sql: Sql;
  let world: ReturnType<typeof createWorld>;
  let authz: typeof import("@/lib/authz");
  let owner: TestUser, admin: TestUser, assigned: TestUser, unassigned: TestUser, removed: TestUser, revoked: TestUser;
  let otherOrg: TestUser, platformAdmin: TestUser, guardian: TestUser;
  let orgA: string, orgB: string;
  let caseA: string, removedAssignment: string;

  const as = (u: TestUser | null) => {
    session.user = u;
  };

  const routes = async () => ({
    kase: await import("@/app/api/cases/[id]/route"),
    team: await import("@/app/api/cases/[id]/assignments/route"),
    member: await import("@/app/api/cases/[id]/assignments/[assignmentId]/route"),
  });

  async function patchCase(caseId: string, score: number) {
    const { kase } = await routes();
    return kase.PATCH(post(`http://localhost/api/cases/${caseId}`, { facp_score: score }, "PATCH"), ctx({ id: caseId }));
  }

  async function addMember(orgId: string, u: TestUser, role: "owner" | "admin" | "member" = "member") {
    await sql`insert into org_members (org_id, user_id, org_role) values (${orgId}, ${u.id}, ${role}) on conflict do nothing`;
  }

  async function assign(caseId: string, u: TestUser, careRole: "lead" | "member" = "member") {
    const [row] = await sql<{ id: string }[]>`
      insert into case_assignments (case_id, user_id, care_role) values (${caseId}, ${u.id}, ${careRole}) returning id`;
    return row.id;
  }

  async function listed(u: TestUser) {
    const { listCases } = await import("@/lib/queries/cases");
    return (await listCases(u.id)).map((c) => c.id);
  }

  beforeAll(async () => {
    sql = postgres(process.env.DATABASE_URL as string, { max: 4, prepare: false, onnotice: () => {} });
    const db = (await import("@/lib/db")).supabaseAdmin();
    authz = await import("@/lib/authz");
    world = createWorld(sql, db, "t022a");
    owner = await world.user("owner", "provider");
    admin = await world.user("admin", "provider");
    assigned = await world.user("assigned", "provider");
    unassigned = await world.user("unassigned", "provider");
    removed = await world.user("removed", "provider");
    revoked = await world.user("revoked", "provider");
    otherOrg = await world.user("other-org", "provider");
    platformAdmin = await world.user("platform-admin", "platform_admin");
    guardian = await world.user("guardian", "guardian");
    orgA = await world.org(owner, "Centre A");
    orgB = await world.org(otherOrg, "Solo B");
    await addMember(orgA, admin, "admin");
    for (const u of [assigned, unassigned, removed, revoked]) await addMember(orgA, u);
    ({ caseId: caseA } = await world.kase(orgA));
    await world.kase(orgB);
    await assign(caseA, assigned);
    removedAssignment = await assign(caseA, removed);
    await assign(caseA, revoked);
    await sql`update case_assignments set removed_at = now() where id = ${removedAssignment}`;
    await sql`update org_members set status = 'revoked', revoked_at = now() where org_id = ${orgA} and user_id = ${revoked.id}`;
  });

  afterAll(async () => {
    await world?.cleanup();
    await sql?.end({ timeout: 5 });
  });

  beforeEach(() => as(null));

  describe("access matrix: {role} x {list, read, write}", () => {
    type Expect = { list: boolean; read: number | null; write: number };
    const matrix = (): [string, TestUser, Expect][] => [
      ["owner", owner, { list: true, read: null, write: 200 }],
      ["admin", admin, { list: true, read: null, write: 200 }],
      ["assigned member", assigned, { list: true, read: null, write: 200 }],
      ["unassigned member", unassigned, { list: false, read: 404, write: 404 }],
      ["removed member (assignment removed)", removed, { list: false, read: 404, write: 404 }],
      ["revoked member (org membership revoked)", revoked, { list: false, read: 404, write: 404 }],
      ["other-org provider", otherOrg, { list: false, read: 404, write: 404 }],
      ["platform admin without membership", platformAdmin, { list: false, read: 404, write: 404 }],
      ["guardian", guardian, { list: false, read: 403, write: 403 }],
    ];

    const ROWS = [
      "owner: list yes, read 200, write 200",
      "admin: list yes, read 200, write 200",
      "assigned member: list yes, read 200, write 200",
      "unassigned member: list no, read 404, write 404",
      "removed member: list no, read 404, write 404",
      "revoked member: list no, read 404, write 404",
      "other-org provider: list no, read 404, write 404",
      "platform_admin: list no, read 404, write 404",
      "guardian: list no, read 403, write 403",
    ];
    it.each(ROWS.map((row, i) => [row, i] as const))("%s", async (_row, i) => {
      const [name, user, expected] = matrix()[i];
      expect((await listed(user)).includes(caseA), `${name} list`).toBe(expected.list);
      as(user);
      const read = await authz.requireCaseAccess(caseA);
      expect(read?.status ?? null, `${name} read`).toBe(expected.read);
      const team = await (await routes()).team.GET(post("http://localhost/x", undefined, "GET"), ctx({ id: caseA }));
      expect(team.status, `${name} read team`).toBe(expected.read ?? 200);
      const write = await patchCase(caseA, 40 + i);
      expect(write.status, `${name} write`).toBe(expected.write);
    });

    it("access levels: owner/admin manage, assigned member assigned", async () => {
      expect(await authz.getCaseAccessLevel(owner.id, caseA)).toBe("manage");
      expect(await authz.getCaseAccessLevel(admin.id, caseA)).toBe("manage");
      expect(await authz.getCaseAccessLevel(assigned.id, caseA)).toBe("assigned");
      expect(await authz.getCaseAccessLevel(unassigned.id, caseA)).toBeNull();
      expect(await authz.getCaseAccessLevel(owner.id, "not-a-uuid")).toBeNull();
    });

    it("an unchanged case was not written by denied callers", async () => {
      const [row] = await sql<{ facp_score: number | null }[]>`select facp_score from cases where id = ${caseA}`;
      expect([40, 41, 42]).toContain(row.facp_score);
    });
  });

  describe("care team API (FR-3)", () => {
    it("adds, rejects non-members and duplicates, keeps the last lead, removes and ends access", async () => {
      const { caseId: k } = await world.kase(orgA);
      const { team, member } = await routes();
      const add = (body: unknown) => team.POST(post("http://localhost/x", body), ctx({ id: k }));

      // Only owners/admins/lead manage: an assigned plain member gets 403.
      await assign(k, assigned);
      as(assigned);
      expect((await add({ user_id: unassigned.id })).status).toBe(403);

      as(admin);
      expect((await listed(unassigned)).includes(k)).toBe(false);
      const created = await add({ user_id: unassigned.id, care_role: "member", discipline_label: "Occupational therapist" });
      expect(created.status).toBe(201);
      const { assignment } = await created.json();
      expect(assignment).toMatchObject({ user_id: unassigned.id, care_role: "member", discipline_label: "Occupational therapist" });
      expect((await listed(unassigned)).includes(k)).toBe(true);
      as(unassigned);
      expect(await authz.requireCaseAccess(k)).toBeNull();

      as(admin);
      expect((await add({ user_id: unassigned.id })).status).toBe(409);
      const outsider = await add({ user_id: otherOrg.id });
      expect(outsider.status).toBe(422);
      expect(await outsider.json()).toEqual({ error: "This person is not in your organisation" });
      expect((await add({ user_id: revoked.id })).status).toBe(422);
      expect((await add({ user_id: unassigned.id, discipline_label: "x".repeat(61) })).status).toBe(400);

      // The world case has the org owner as its only lead.
      const [lead] = await sql<{ id: string }[]>`
        select id from case_assignments where case_id = ${k} and care_role = 'lead' and removed_at is null`;
      const last = await member.DELETE(post("http://localhost/x", undefined, "DELETE"), ctx({ id: k, assignmentId: lead.id }));
      expect(last.status).toBe(409);
      expect(await last.json()).toEqual({ error: "Assign another lead first" });
      const demote = await member.PATCH(post("http://localhost/x", { care_role: "member" }, "PATCH"), ctx({ id: k, assignmentId: lead.id }));
      expect(demote.status).toBe(409);

      const gone = await member.DELETE(post("http://localhost/x", undefined, "DELETE"), ctx({ id: k, assignmentId: assignment.assignment_id }));
      expect(gone.status).toBe(200);
      as(unassigned);
      expect((await authz.requireCaseAccess(k))?.status).toBe(404);
      expect((await patchCase(k, 10)).status).toBe(404);
      expect((await listed(unassigned)).includes(k)).toBe(false);

      const audits = await sql<{ action: string; actor_user_id: string }[]>`
        select action, actor_user_id from audit_events where case_id = ${k} and action in ('case.assigned', 'case.unassigned')`;
      expect(audits.map((a) => a.action).sort()).toEqual(["case.assigned", "case.unassigned"]);
      expect(audits.every((a) => a.actor_user_id === admin.id)).toBe(true);
    });

    it("making someone lead hands the lead over; the lead may manage the team", async () => {
      const { caseId: k } = await world.kase(orgA);
      const { team, member } = await routes();
      as(owner);
      const res = await team.POST(post("http://localhost/x", { user_id: assigned.id, care_role: "lead" }), ctx({ id: k }));
      expect(res.status).toBe(201);
      const leads = await sql<{ user_id: string }[]>`
        select user_id from case_assignments where case_id = ${k} and care_role = 'lead' and removed_at is null`;
      expect(leads.map((l) => l.user_id)).toEqual([assigned.id]);

      as(assigned);
      const added = await team.POST(post("http://localhost/x", { user_id: unassigned.id }), ctx({ id: k }));
      expect(added.status).toBe(201);
      const { assignment } = await added.json();
      const promoted = await member.PATCH(post("http://localhost/x", { care_role: "lead" }, "PATCH"), ctx({ id: k, assignmentId: assignment.assignment_id }));
      expect(promoted.status).toBe(200);
      const [{ n }] = await sql<{ n: number }[]>`
        select count(*)::int as n from case_assignments where case_id = ${k} and care_role = 'lead' and removed_at is null`;
      expect(n).toBe(1);
      // No longer lead and not admin: cannot change the team any more.
      expect((await team.POST(post("http://localhost/x", { user_id: removed.id }), ctx({ id: k }))).status).toBe(403);
    });

    it("concurrent lead hand-overs leave exactly one lead", async () => {
      const { caseId: k } = await world.kase(orgA);
      const { addAssignment } = await import("@/lib/cases/team");
      const results = await Promise.all(
        [assigned, unassigned, removed].map((u) => addAssignment(k, owner.id, { user_id: u.id, care_role: "lead", discipline_label: null })),
      );
      expect(results.every((r) => r.ok)).toBe(true);
      const [{ n }] = await sql<{ n: number }[]>`
        select count(*)::int as n from case_assignments where case_id = ${k} and care_role = 'lead' and removed_at is null`;
      expect(n).toBe(1);
    });

    it("membership revocation ends access on the next request (FR-7)", async () => {
      const temp = await world.user("temp", "provider");
      await addMember(orgA, temp);
      await assign(caseA, temp);
      as(temp);
      expect(await authz.requireCaseAccess(caseA)).toBeNull();
      const { revokeMember } = await import("@/lib/orgs");
      expect((await revokeMember(orgA, temp.id)).ok).toBe(true);
      expect((await authz.requireCaseAccess(caseA))?.status).toBe(404);
    });
  });

  describe("initial care team and backfill (FR-1)", () => {
    it("new cases get their creator (or the earliest owner) as lead", async () => {
      const coOwner = await world.user("co-owner", "provider");
      await addMember(orgA, coOwner, "owner");
      try {
        const { caseId: noCreator } = await world.kase(orgA);
        const team = await sql<{ user_id: string; care_role: string }[]>`
          select user_id, care_role from case_assignments where case_id = ${noCreator} and removed_at is null
          order by (care_role = 'lead') desc`;
        expect(team).toEqual([
          { user_id: owner.id, care_role: "lead" },
          { user_id: coOwner.id, care_role: "member" },
        ]);

        as(assigned);
        const { POST } = await import("@/app/api/cases/route");
        const res = await POST(post("http://localhost/api/cases", { child_alias: "t022 created (synthetic)", parent_alias: "p", org_id: orgA }));
        expect(res.status).toBe(201);
        const created = (await res.json()).case.id as string;
        world.trackChild((await sql<{ child_id: string }[]>`select child_id from cases where id = ${created}`)[0].child_id);
        const [lead] = await sql<{ user_id: string }[]>`
          select user_id from case_assignments where case_id = ${created} and care_role = 'lead' and removed_at is null`;
        expect(lead.user_id).toBe(assigned.id);
        expect(await authz.requireCaseAccess(created)).toBeNull();
        await sql`delete from cases where id = ${created}`;
      } finally {
        await sql`delete from org_members where org_id = ${orgA} and user_id = ${coOwner.id}`;
      }
    });

    it("backfill assigns a lead to legacy cases once and audits it", async () => {
      const { caseId: legacy } = await world.kase(orgA);
      await sql`delete from case_assignments where case_id = ${legacy}`;
      const [{ n: first }] = await sql<{ n: number }[]>`
        select public.assign_initial_care_team(${legacy}, 'case.assignment_backfilled') as n`;
      expect(first).toBe(1);
      const [{ n: again }] = await sql<{ n: number }[]>`
        select public.assign_initial_care_team(${legacy}, 'case.assignment_backfilled') as n`;
      expect(again).toBe(0);
      const leads = await sql`select 1 from case_assignments where case_id = ${legacy} and care_role = 'lead' and removed_at is null`;
      expect(leads).toHaveLength(1);
      const audits = await sql<{ details: { lead_user_id: string } }[]>`
        select details from audit_events where case_id = ${legacy} and action = 'case.assignment_backfilled'`;
      expect(audits).toHaveLength(1);
      expect(audits[0].details.lead_user_id).toBe(owner.id);
    });

    it("a case without a lead (org had no owner) gets the first owner who joins as lead", async () => {
      const [{ id: bare }] = await sql<{ id: string }[]>`
        insert into organizations (name, slug, kind) values ('t022 ownerless (synthetic)', ${`t022-ownerless-${world.tag}`}, 'centre')
        returning id`;
      try {
        const [{ id: k, child_id }] = await sql<{ id: string; child_id: string }[]>`
          insert into cases (org_id, child_alias, parent_alias) values (${bare}, 't022 legacy (synthetic)', 'p')
          returning id, child_id`;
        world.trackChild(child_id);
        expect(await sql`select 1 from case_assignments where case_id = ${k}`).toHaveLength(0);
        await addMember(bare, admin, "member");
        await addMember(bare, unassigned, "owner");
        const team = await sql<{ user_id: string; care_role: string }[]>`
          select user_id, care_role from case_assignments where case_id = ${k} and removed_at is null`;
        expect(team).toEqual([{ user_id: unassigned.id, care_role: "lead" }]);
        await sql`delete from cases where id = ${k}`;
      } finally {
        await sql`delete from organizations where id = ${bare}`;
      }
    });

    it("one active lead per case and one active assignment per person are enforced by the schema", async () => {
      const { caseId: k } = await world.kase(orgA);
      await expect(assign(k, admin, "lead")).rejects.toThrow(/case_assignments_one_lead_uq/);
      await assign(k, admin);
      await expect(assign(k, admin)).rejects.toThrow(/case_assignments_active_uq/);
    });
  });

  describe("row level security (NFR-2)", () => {
    const visible = (userId: string, query: (tx: Sql) => Promise<{ n: number }[]>) =>
      sql.begin(async (tx) => {
        await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, role: "authenticated" })}, true)`;
        await tx`set local role authenticated`;
        const [{ n }] = await query(tx as unknown as Sql);
        return n;
      });

    it("cases and assignments follow the care team rule; no client writes", async () => {
      const cases = (tx: Sql) => tx<{ n: number }[]>`select count(*)::int as n from cases where id = ${caseA}`;
      const team = (tx: Sql) => tx<{ n: number }[]>`select count(*)::int as n from case_assignments where case_id = ${caseA}`;
      expect(await visible(assigned.id, cases)).toBe(1);
      expect(await visible(admin.id, cases)).toBe(1);
      expect(await visible(unassigned.id, cases)).toBe(0);
      expect(await visible(platformAdmin.id, cases)).toBe(0);
      expect(await visible(assigned.id, team)).toBeGreaterThan(0);
      expect(await visible(unassigned.id, team)).toBe(0);
      await expect(
        sql.begin(async (tx) => {
          await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: owner.id, role: "authenticated" })}, true)`;
          await tx`set local role authenticated`;
          await tx`insert into case_assignments (case_id, user_id) values (${caseA}, ${unassigned.id})`;
        }),
      ).rejects.toThrow(/permission denied/);
    });

    it("service-only functions are not executable by browser roles", async () => {
      const rows = await sql<{ fn: string; anon: boolean; authed: boolean }[]>`
        select p.proname as fn,
               has_function_privilege('anon', p.oid, 'execute') as anon,
               has_function_privilege('authenticated', p.oid, 'execute') as authed
        from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
        where ns.nspname = 'public' and p.proname in (
          'case_access_level', 'can_manage_case_team', 'accessible_cases', 'active_sharing_grants', 'assign_initial_care_team',
          'list_case_team', 'list_case_team_candidates', 'list_child_care_team', 'add_case_assignment',
          'update_case_assignment', 'remove_case_assignment', 'create_sharing_grant', 'revoke_sharing_grant')`;
      expect(rows).toHaveLength(13);
      for (const row of rows) expect([row.fn, row.anon, row.authed]).toEqual([row.fn, false, false]);
    });
  });
});
