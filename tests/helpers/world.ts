// Ticket 020: synthetic users, organisations and cases for the consent/children DB suites. Each suite mocks
// `@/lib/auth` with a hoisted `session` object and passes a setter here. Everything is removed in cleanup().
import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { CONSENT_FEATURES } from "@/lib/consent/features";
import { purgeSyntheticChildren } from "./consent";

type Db = ReturnType<typeof import("@/lib/db").supabaseAdmin>;
export type TestUser = { id: string; email: string };

export function createWorld(sql: Sql, db: Db, prefix: string) {
  const tag = randomUUID().slice(0, 8);
  const users: string[] = [];
  const orgs: string[] = [];
  const cases: string[] = [];
  const children = new Set<string>();

  async function user(name: string, role: "provider" | "guardian" | "platform_admin", opts: { phoneVerified?: boolean } = {}) {
    const email = `${prefix}-${name}-${tag}@example.test`;
    const { data, error } = await db.auth.admin.createUser({
      email,
      email_confirm: true,
      password: randomUUID(),
      ...(role === "guardian" ? {} : { app_metadata: { role } }),
    });
    if (error || !data.user) throw new Error(`createUser failed: ${error?.message}`);
    users.push(data.user.id);
    await sql`update user_profiles set role = ${role} where id = ${data.user.id}`;
    if (opts.phoneVerified) await sql`update user_profiles set phone_verified_at = now() where id = ${data.user.id}`;
    return { id: data.user.id, email } satisfies TestUser;
  }

  async function org(owner: TestUser, name: string) {
    const { createOrganization } = await import("@/lib/orgs");
    const id = (await createOrganization(owner.id, { name: `${prefix} ${name} ${tag}`, kind: "centre" })).id;
    orgs.push(id);
    return id;
  }

  async function member(orgId: string, u: TestUser) {
    await sql`insert into org_members (org_id, user_id, org_role) values (${orgId}, ${u.id}, 'member') on conflict do nothing`;
  }

  /** A case with an intake token (7 days), an extracted session with audio path, and a final assessment report. */
  async function kase(orgId: string, opts: { childId?: string; language?: "en" | "hi" | "te" } = {}) {
    const caseId = randomUUID();
    const recordingId = randomUUID();
    const reportId = randomUUID();
    const token = `${prefix}tok${randomUUID().replace(/-/g, "")}`;
    await sql`
      insert into cases (id, org_id, child_alias, parent_alias, parent_email, language, intake_token, child_id)
      values (${caseId}, ${orgId}, ${`${prefix} child (synthetic)`}, 'Parent (synthetic)', 'parent@example.test',
              ${opts.language ?? "en"}, ${token}, ${opts.childId ?? null})`;
    cases.push(caseId);
    await sql`
      insert into recordings (id, case_id, kind, session_number, status, storage_path, mime_type, segments)
      values (${recordingId}, ${caseId}, 'session', 1, 'transcribed', ${`${caseId}/${recordingId}.wav`}, 'audio/wav',
              ${sql.json([{ id: "s1", speaker: "parent", speaker_label: "speaker_1", start_sec: 0, end_sec: 5, text: "He lines up toys." }])})`;
    await sql`
      insert into reports (id, case_id, recording_id, kind, content, content_md, status)
      values (${reportId}, ${caseId}, ${recordingId}, 'assessment', '{}'::jsonb, '# Report (synthetic)', 'final')`;
    const [{ child_id }] = await sql<{ child_id: string }[]>`select child_id from cases where id = ${caseId}`;
    children.add(child_id);
    return { caseId, recordingId, reportId, token, childId: child_id };
  }

  async function link(childId: string, u: TestUser, relationship = "mother") {
    const [row] = await sql<{ id: string }[]>`
      insert into guardian_links (child_id, user_id, relationship, status, verification_method, declared_at)
      values (${childId}, ${u.id}, ${relationship}, 'active', 'self_registered', now())
      on conflict (child_id, user_id) do update set status = 'active', revoked_at = null
      returning id`;
    children.add(childId);
    return row.id;
  }

  /** Digital grant through record_consent (the guardian needs a verified phone). */
  async function grant(childId: string, guardian: TestUser, linkId: string, features: readonly string[] = CONSENT_FEATURES) {
    const docs = await sql<{ id: string }[]>`
      select distinct on (feature) id from consent_documents where locale = 'en' and feature in ${sql(features as string[])}
      order by feature, version desc`;
    await sql`select public.record_consent(${sql.json({
      child_id: childId,
      action: "granted",
      method: "digital",
      features,
      document_ids: docs.map((d) => d.id),
      guardian_user_id: guardian.id,
      guardian_link_id: linkId,
      user_agent: "test:synthetic",
    })}::jsonb)`;
  }

  async function withdraw(childId: string, guardian: TestUser, linkId: string, features: readonly string[]) {
    await sql`select public.record_consent(${sql.json({
      child_id: childId,
      action: "withdrawn",
      method: "digital",
      features,
      guardian_user_id: guardian.id,
      guardian_link_id: linkId,
      user_agent: "test:synthetic",
    })}::jsonb)`;
  }

  function trackChild(id: string) {
    children.add(id);
  }

  async function cleanup() {
    const childIds = [...children];
    const guardianChildren = users.length
      ? await sql<{ child_id: string }[]>`select child_id from guardian_links where user_id in ${sql(users)}`
      : [];
    for (const r of guardianChildren) childIds.push(r.child_id);
    if (cases.length) await sql`delete from cases where id in ${sql(cases)}`;
    if (orgs.length) {
      await sql`delete from cases where org_id in ${sql(orgs)}`;
      await sql`delete from organizations where id in ${sql(orgs)}`;
    }
    // 032: grant notifications are outbox events keyed by the grant (notifications cascade).
    if (childIds.length) await sql`delete from outbox_events where payload ->> 'child_id' in ${sql([...new Set(childIds)])}`;
    await purgeSyntheticChildren(sql, [...new Set(childIds)]);
    if (users.length) await sql`delete from child_claim_attempts where user_id in ${sql(users)}`;
    for (const id of users) await db.auth.admin.deleteUser(id);
  }

  return { tag, user, org, member, kase, link, grant, withdraw, trackChild, cleanup };
}

export const post = (url: string, body?: unknown, method = "POST") =>
  new Request(url, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

export const ctx = <T extends Record<string, string>>(params: T) => ({ params: Promise.resolve(params) });
