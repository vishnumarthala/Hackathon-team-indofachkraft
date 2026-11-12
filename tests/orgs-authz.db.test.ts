// Ticket 017: tenant isolation, roles and organisation onboarding against the configured local Supabase
// (DATABASE_URL + NEXT_PUBLIC_SUPABASE_URL must point at the same stack). Skipped without DATABASE_URL or
// with SKIP_DB_TESTS=1. Every test account, organisation and case is synthetic and removed afterwards.
import { randomUUID } from "node:crypto";
import { loadEnvConfig } from "@next/env";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

loadEnvConfig(process.cwd(), false, { info: () => {}, error: () => {} });
const enabled = Boolean(process.env.DATABASE_URL) && process.env.SKIP_DB_TESTS !== "1";

const session = vi.hoisted(() => ({ user: null as null | { id: string; email: string } }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getAuthenticatedUser: vi.fn(async () => session.user) };
});

describe.skipIf(!enabled)("organisations and resource-level access (database)", { timeout: 60_000 }, () => {
  let sql: Sql;
  let authz: typeof import("@/lib/authz");
  let orgs: typeof import("@/lib/orgs");
  let db: ReturnType<typeof import("@/lib/db").supabaseAdmin>;
  const users: string[] = [];
  const orgIds: string[] = [];
  const tag = randomUUID().slice(0, 8);

  type TestUser = { id: string; email: string };
  let ownerA: TestUser, memberA: TestUser, ownerB: TestUser, guardian: TestUser, admin: TestUser;
  let orgA: string, orgB: string;
  let caseA: string, recordingA: string, reportA: string, factA: string;

  async function makeUser(name: string, role?: "platform_admin"): Promise<TestUser> {
    const email = `t017-${name}-${tag}@example.com`;
    const { data, error } = await db.auth.admin.createUser({
      email,
      email_confirm: true,
      password: randomUUID(),
      app_metadata: { role: role ?? "provider" },
    });
    if (error || !data.user) throw new Error(`createUser failed: ${error?.message}`);
    users.push(data.user.id);
    return { id: data.user.id, email };
  }

  const as = (user: TestUser | null) => {
    session.user = user;
  };

  beforeAll(async () => {
    sql = postgres(process.env.DATABASE_URL as string, { max: 4, prepare: false, onnotice: () => {} });
    authz = await import("@/lib/authz");
    orgs = await import("@/lib/orgs");
    db = (await import("@/lib/db")).supabaseAdmin();

    ownerA = await makeUser("owner-a");
    memberA = await makeUser("member-a");
    ownerB = await makeUser("owner-b");
    guardian = await makeUser("guardian");
    admin = await makeUser("admin", "platform_admin");
    await sql`update user_profiles set role = 'guardian' where id = ${guardian.id}`;

    orgA = (await orgs.createOrganization(ownerA.id, { name: `t017 Centre A ${tag}`, kind: "centre" })).id;
    orgB = (await orgs.createOrganization(ownerB.id, { name: `t017 Solo B ${tag}`, kind: "solo" })).id;
    orgIds.push(orgA, orgB);
    await sql`insert into org_members (org_id, user_id, org_role) values (${orgA}, ${memberA.id}, 'member')`;

    caseA = randomUUID();
    recordingA = randomUUID();
    reportA = randomUUID();
    await sql`insert into cases (id, org_id, child_alias, parent_alias) values (${caseA}, ${orgA}, 't017 child (synthetic)', 't017 parent')`;
    await sql`insert into recordings (id, case_id, kind, session_number, status) values (${recordingA}, ${caseA}, 'session', 1, 'extracted')`;
    await sql`insert into reports (id, case_id, recording_id, kind, content, content_md) values (${reportA}, ${caseA}, ${recordingA}, 'assessment', '{}'::jsonb, 'x')`;
    [{ id: factA }] = await sql<{ id: string }[]>`
      insert into facts (case_id, recording_id, instrument, item_id, source) values (${caseA}, ${recordingA}, 'ISAA', '1', 'session') returning id`;
  });

  afterAll(async () => {
    if (orgIds.length) {
      await sql`delete from cases where org_id in ${sql(orgIds)}`;
      await sql`delete from organizations where id in ${sql(orgIds)}`;
    }
    for (const id of users) await db.auth.admin.deleteUser(id);
    await sql.end({ timeout: 5 });
  });

  beforeEach(() => as(null));

  describe("resource gates", () => {
    const gates = () =>
      [
        ["case", () => authz.requireCaseAccess(caseA)],
        ["recording", () => authz.requireRecordingAccess(recordingA)],
        ["report", () => authz.requireReportAccess(reportA)],
        ["fact", () => authz.requireFactAccess(factA)],
      ] as const;

    it("401 without a session and 403 for guardians", async () => {
      for (const [, check] of gates()) expect((await check())?.status).toBe(401);
      as(guardian);
      for (const [, check] of gates()) expect((await check())?.status).toBe(403);
    });

    it("allows active members of the case's organisation", async () => {
      for (const user of [ownerA, memberA]) {
        as(user);
        for (const [, check] of gates()) expect(await check()).toBeNull();
      }
    });

    it("404 with the route message for other tenants, platform admins without membership, and bad ids", async () => {
      for (const user of [ownerB, admin]) {
        as(user);
        for (const [name, check] of gates()) {
          const res = await check();
          expect(res?.status, `${name} for ${user.email}`).toBe(404);
        }
      }
      as(ownerB);
      expect(await (await authz.requireCaseAccess(caseA))!.json()).toEqual({ error: "Case not found" });
      expect(await (await authz.requireRecordingAccess(recordingA))!.json()).toEqual({ error: "Session not found" });
      as(ownerA);
      expect((await authz.requireCaseAccess("not-a-uuid"))?.status).toBe(404);
      expect((await authz.requireFactAccess(randomUUID()))?.status).toBe(404);
    });

    it("cross-tenant route calls get 404 and change nothing", async () => {
      as(ownerB);
      const { PATCH } = await import("@/app/api/cases/[id]/route");
      const res = await PATCH(
        new Request(`http://localhost/api/cases/${caseA}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ facp_score: 99 }),
        }),
        { params: Promise.resolve({ id: caseA }) },
      );
      expect(res.status).toBe(404);
      const [row] = await sql<{ facp_score: number | null }[]>`select facp_score from cases where id = ${caseA}`;
      expect(row.facp_score).toBeNull();
    });
  });

  describe("case creation picks the organisation explicitly", () => {
    const create = async (body: Record<string, unknown>) => {
      const { POST } = await import("@/app/api/cases/route");
      return POST(
        new Request("http://localhost/api/cases", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ child_alias: "t017 new (synthetic)", parent_alias: "p", ...body }),
        }),
      );
    };

    it("uses the only organisation, rejects missing/foreign org and users without one", async () => {
      as(ownerB);
      const res = await create({});
      expect(res.status).toBe(201);
      const created = (await res.json()).case;
      expect(created.org_id).toBe(orgB);
      expect(created.created_by).toBe(ownerB.id);

      expect((await create({ org_id: orgA })).status).toBe(403);

      as(admin);
      expect(await (await create({})).json()).toEqual({ error: "Create or join an organisation first" });

      await sql`insert into org_members (org_id, user_id, org_role) values (${orgB}, ${memberA.id}, 'member')`;
      as(memberA);
      const several = await create({});
      expect(several.status).toBe(422);
      expect((await create({ org_id: orgB })).status).toBe(201);
      await sql`delete from org_members where org_id = ${orgB} and user_id = ${memberA.id}`;
    });
  });

  describe("invitations", () => {
    const invite = (email: string, now?: Date) => orgs.createInvitation(orgA, ownerA.id, { email, org_role: "member" }, now);

    it("stores only a hash, is single-use, checks email, and promotes guardians", async () => {
      const { token, invitationId } = await invite(guardian.email);
      const [row] = await sql<{ token_hash: string }[]>`select token_hash from org_invitations where id = ${invitationId}`;
      expect(row.token_hash).toBe(orgs.hashToken(token));
      expect(row.token_hash).not.toContain(token);

      expect(await orgs.acceptInvitation(ownerB, token)).toMatchObject({ ok: false, status: 403 });
      expect(await orgs.acceptInvitation(guardian, token)).toEqual({ ok: true, data: { orgId: orgA } });
      expect(await orgs.acceptInvitation(guardian, token)).toMatchObject({ ok: false, status: 404 });

      const [profile] = await sql<{ role: string }[]>`select role from user_profiles where id = ${guardian.id}`;
      expect(profile.role).toBe("provider");
      as(guardian);
      expect(await authz.requireCaseAccess(caseA)).toBeNull();
    });

    it("rejects expired and revoked invitations", async () => {
      const expired = await invite(ownerB.email, new Date(Date.now() - 8 * 24 * 60 * 60 * 1000));
      expect(await orgs.acceptInvitation(ownerB, expired.token)).toMatchObject({ ok: false, status: 404 });

      const revoked = await invite(ownerB.email);
      expect(await orgs.revokeInvitation(orgA, revoked.invitationId)).toBe(true);
      expect(await orgs.revokeInvitation(orgB, revoked.invitationId)).toBe(false);
      expect(await orgs.acceptInvitation(ownerB, revoked.token)).toMatchObject({ ok: false, status: 404 });
    });

    it("two concurrent accepts of one token: exactly one succeeds", async () => {
      const second = await makeUser("racer");
      const { token } = await invite(second.email);
      const results = await Promise.all([orgs.acceptInvitation(second, token), orgs.acceptInvitation(second, token)]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
    });
  });

  describe("membership revocation", () => {
    it("blocks removing the last owner and ends access immediately", async () => {
      expect(await orgs.revokeMember(orgB, ownerB.id)).toMatchObject({ ok: false, status: 409 });

      const temp = await makeUser("temp");
      await sql`insert into org_members (org_id, user_id, org_role) values (${orgA}, ${temp.id}, 'member')`;
      as(temp);
      expect(await authz.requireCaseAccess(caseA)).toBeNull();
      expect(await orgs.revokeMember(orgA, temp.id)).toEqual({ ok: true, data: null });
      expect((await authz.requireCaseAccess(caseA))?.status).toBe(404);
      expect(await orgs.revokeMember(orgA, temp.id)).toMatchObject({ ok: false, status: 404 });
    });

    it("concurrent revocation of two owners keeps one owner", async () => {
      const coOwner = await makeUser("co-owner");
      await sql`insert into org_members (org_id, user_id, org_role) values (${orgB}, ${coOwner.id}, 'owner')`;
      const results = await Promise.all([orgs.revokeMember(orgB, ownerB.id), orgs.revokeMember(orgB, coOwner.id)]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      const [{ n }] = await sql<{ n: number }[]>`
        select count(*)::int as n from org_members where org_id = ${orgB} and org_role = 'owner' and status = 'active'`;
      expect(n).toBe(1);
    });
  });

  describe("row level security for browser reads", () => {
    it("members read their org's cases; others read none", async () => {
      const visible = async (userId: string) =>
        sql.begin(async (tx) => {
          await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, role: "authenticated" })}, true)`;
          await tx`set local role authenticated`;
          const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from cases where id = ${caseA}`;
          return n;
        });
      expect(await visible(memberA.id)).toBe(1);
      expect(await visible(admin.id)).toBe(0);
    });
  });
});
