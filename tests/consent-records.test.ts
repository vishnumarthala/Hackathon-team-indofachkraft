// Ticket 020 FR-5/FR-11/FR-13/FR-15/FR-16/FR-17: the append-only consent log, the strict (fail-closed) write
// path, and the guardian flows with their authorisation negatives. Local Supabase stack only; synthetic data.
import { loadEnvConfig } from "@next/env";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorld, ctx, post, type TestUser } from "./helpers/world";

loadEnvConfig(process.cwd(), false, { info: () => {}, error: () => {} });
const enabled = Boolean(process.env.DATABASE_URL) && process.env.SKIP_DB_TESTS !== "1";

const session = vi.hoisted(() => ({ user: null as null | { id: string; email: string } }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getAuthenticatedUser: vi.fn(async () => session.user) };
});

describe.skipIf(!enabled)("consent log and guardian flows (database)", { timeout: 90_000 }, () => {
  let sql: Sql;
  let db: ReturnType<typeof import("@/lib/db").supabaseAdmin>;
  let world: ReturnType<typeof createWorld>;
  let provider: TestUser, guardianA: TestUser, guardianB: TestUser, unverified: TestUser;
  const as = (u: TestUser | null) => {
    session.user = u;
  };

  const routes = async () => ({
    children: await import("@/app/api/family/children/route"),
    consents: await import("@/app/api/family/children/[id]/consents/route"),
    withdraw: await import("@/app/api/family/children/[id]/consents/[feature]/withdraw/route"),
    leave: await import("@/app/api/family/children/[id]/leave/route"),
  });

  async function addChild(user: TestUser, name = "t020 Asha (synthetic)") {
    as(user);
    const { children } = await routes();
    const res = await children.POST(
      post("http://localhost/x", { display_name: name, date_of_birth: "2023-05-01", relationship: "mother", declaration: true }),
    );
    expect(res.status).toBe(201);
    const { child } = (await res.json()) as { child: { id: string } };
    world.trackChild(child.id);
    return child.id;
  }

  async function docId(feature: string, locale = "en") {
    const [d] = await sql<{ id: string }[]>`
      select id from consent_documents where feature = ${feature} and locale = ${locale} order by version desc limit 1`;
    return d.id;
  }

  beforeAll(async () => {
    sql = postgres(process.env.DATABASE_URL as string, { max: 4, prepare: false, onnotice: () => {} });
    db = (await import("@/lib/db")).supabaseAdmin();
    world = createWorld(sql, db, "t020r");
    provider = await world.user("provider", "provider");
    guardianA = await world.user("guardian-a", "guardian", { phoneVerified: true });
    guardianB = await world.user("guardian-b", "guardian", { phoneVerified: true });
    unverified = await world.user("google-only", "guardian");
    await world.org(provider, "Centre A");
  });

  afterAll(async () => {
    await world?.cleanup();
    await sql?.end({ timeout: 5 });
  });

  beforeEach(() => as(null));

  it("FR-11: add a child creates the child and an active self-registered link; declaration is required", async () => {
    as(guardianA);
    const { children } = await routes();
    const missing = await children.POST(post("http://localhost/x", { display_name: "t020 X", relationship: "mother" }));
    expect(missing.status).toBe(400);
    const childId = await addChild(guardianA);
    const [link] = await sql`select status, verification_method, relationship from guardian_links where child_id = ${childId}`;
    expect(link).toMatchObject({ status: "active", verification_method: "self_registered", relationship: "mother" });
    const [child] = await sql`select source, date_of_birth::text as dob from children where id = ${childId}`;
    expect(child).toEqual({ source: "guardian", dob: "2023-05-01" });
    as(guardianA);
    const list = await (await children.GET()).json();
    expect(list.children.map((c: { id: string }) => c.id)).toContain(childId);
  });

  it("FR-13 / E-2: grant records the exact document + locale, audits consent.granted; withdraw audits consent.withdrawn", async () => {
    const childId = await addChild(guardianA);
    const { consents, withdraw } = await routes();
    as(guardianA);
    const doc = await docId("ai_intake_call", "te");
    const res = await consents.POST(
      post("http://localhost/x", { feature: "ai_intake_call", consent_document_id: doc, agree: true }),
      ctx({ id: childId }),
    );
    expect(res.status).toBe(201);
    expect(((await res.json()) as { state: Record<string, { granted: boolean }> }).state.ai_intake_call.granted).toBe(true);
    const [rec] = await sql<{ consent_document_id: string; method: string; ip_hash: string; guardian_user_id: string }[]>`
      select consent_document_id, method, ip_hash, guardian_user_id from consent_records where child_id = ${childId}`;
    expect(rec).toMatchObject({ consent_document_id: doc, method: "digital", guardian_user_id: guardianA.id });
    expect(rec.ip_hash).toMatch(/^[0-9a-f]{64}$/);
    const [audit] = await sql`select actor, details from audit_events where entity_id = ${childId} and action = 'consent.granted'`;
    expect(audit).toMatchObject({ actor: "parent", details: { features: ["ai_intake_call"], method: "digital" } });

    const w = await withdraw.POST(post("http://localhost/x"), ctx({ id: childId, feature: "ai_intake_call" }));
    expect(w.status).toBe(200);
    expect(((await w.json()) as { state: Record<string, { granted: boolean }> }).state.ai_intake_call.granted).toBe(false);
    const audits = await sql`select 1 from audit_events where entity_id = ${childId} and action = 'consent.withdrawn'`;
    expect(audits).toHaveLength(1);
  });

  it("FR-13: no verified phone -> 422; outdated text -> 409; providers can never grant (403)", async () => {
    const childId = await addChild(unverified);
    const { consents } = await routes();
    as(unverified);
    const body = { feature: "ai_transcription", consent_document_id: await docId("ai_transcription"), agree: true };
    const res = await consents.POST(post("http://localhost/x", body), ctx({ id: childId }));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("Verify your mobile number before giving permission");

    // A v2 text for one feature in Hindi: granting the v1 Hindi text is outdated.
    const [v2] = await sql<{ id: string }[]>`
      insert into consent_documents (feature, version, locale, title, body_md, processors)
      values ('ai_follow_up', 2, 'hi', 't020 v2 (synthetic)', 'synthetic', '[]') returning id`;
    try {
      const own = await addChild(guardianA);
      as(guardianA);
      const old = await sql<{ id: string }[]>`select id from consent_documents where feature = 'ai_follow_up' and locale = 'hi' and version = 1`;
      const outdated = await consents.POST(
        post("http://localhost/x", { feature: "ai_follow_up", consent_document_id: old[0].id, agree: true }),
        ctx({ id: own }),
      );
      expect(outdated.status).toBe(409);
      expect(await outdated.json()).toEqual({ error: "Please review the updated text" });
      const rows = await sql`select 1 from consent_records where child_id = ${own}`;
      expect(rows).toHaveLength(0);
    } finally {
      await sql`delete from consent_documents where id = ${v2.id}`;
    }

    as(provider);
    const forbidden = await consents.POST(post("http://localhost/x", body), ctx({ id: childId }));
    expect(forbidden.status).toBe(403);
  });

  it("FR-15/FR-16: unlinked guardians get 404; leaving takes effect on the next request", async () => {
    const childId = await addChild(guardianB);
    const { consents, withdraw, leave } = await routes();
    const body = { feature: "ai_transcription", consent_document_id: await docId("ai_transcription"), agree: true };
    as(guardianA);
    expect((await consents.POST(post("http://localhost/x", body), ctx({ id: childId }))).status).toBe(404);
    expect((await consents.GET(post("http://localhost/x"), ctx({ id: childId }))).status).toBe(404);
    expect((await withdraw.POST(post("http://localhost/x"), ctx({ id: childId, feature: "ai_transcription" }))).status).toBe(404);
    expect((await leave.POST(post("http://localhost/x"), ctx({ id: childId }))).status).toBe(404);
    const { requireChildGuardian } = await import("@/lib/authz");
    expect(((await requireChildGuardian(childId)) as Response).status).toBe(404);

    as(guardianB);
    expect((await consents.GET(post("http://localhost/x"), ctx({ id: childId }))).status).toBe(200);
    expect((await leave.POST(post("http://localhost/x"), ctx({ id: childId }))).status).toBe(200);
    expect((await consents.GET(post("http://localhost/x"), ctx({ id: childId }))).status).toBe(404);
    expect((await consents.POST(post("http://localhost/x", body), ctx({ id: childId }))).status).toBe(404);
  });

  it("FR-16: a platform admin can revoke a guardian link; providers cannot", async () => {
    const admin = await world.user("admin", "platform_admin");
    const childId = await addChild(guardianB);
    const [link] = await sql<{ id: string }[]>`select id from guardian_links where child_id = ${childId}`;
    const { POST } = await import("@/app/api/admin/guardian-links/[id]/revoke/route");
    as(provider);
    expect((await POST(post("http://localhost/x"), ctx({ id: link.id }))).status).toBe(404);
    as(admin);
    const res = await POST(post("http://localhost/x"), ctx({ id: link.id }));
    expect(res.status).toBe(200);
    as(guardianB);
    const { consents } = await routes();
    expect((await consents.GET(post("http://localhost/x"), ctx({ id: childId }))).status).toBe(404);
  });

  it("a digital grant stops counting once the granting guardian's link is revoked (fail closed)", async () => {
    const childId = await addChild(guardianB);
    const [link] = await sql<{ id: string }[]>`select id from guardian_links where child_id = ${childId} and user_id = ${guardianB.id}`;
    await world.grant(childId, guardianB, link.id, ["ai_transcription"]);
    const { hasConsent } = await import("@/lib/consent");
    expect(await hasConsent(childId, "ai_transcription")).toBe(true);
    await sql`update guardian_links set status = 'revoked', revoked_at = now() where id = ${link.id}`;
    expect(await hasConsent(childId, "ai_transcription")).toBe(false);
  });

  it("FR-5: consent_records cannot be updated or deleted by any role", async () => {
    const childId = await addChild(guardianA);
    const [link] = await sql<{ id: string }[]>`select id from guardian_links where child_id = ${childId}`;
    await world.grant(childId, guardianA, link.id, ["ai_extraction"]);
    await expect(sql`update consent_records set action = 'withdrawn' where child_id = ${childId}`).rejects.toThrow(/append-only/);
    await expect(sql`delete from consent_records where child_id = ${childId}`).rejects.toThrow(/append-only/);
    await expect(sql`truncate consent_records`).rejects.toThrow(/append-only/);
    const upd = await db.from("consent_records").update({ action: "withdrawn" }).eq("child_id", childId).select("id");
    expect(upd.error).not.toBeNull();
    const del = await db.from("consent_records").delete().eq("child_id", childId).select("id");
    expect(del.error).not.toBeNull();
    const ins = await db.from("consent_records").insert({ child_id: childId, feature: "ai_extraction", action: "withdrawn" });
    expect(ins.error).not.toBeNull();
    const [row] = await sql`select action from consent_records where child_id = ${childId}`;
    expect(row.action).toBe("granted");
  });

  it("FR-17: a forced audit failure -> 503, no consent row, state unchanged", async () => {
    const childId = await addChild(guardianA);
    const fn = `t020_fail_audit_${childId.slice(0, 8)}`;
    await sql.unsafe(`
      create function public.${fn}() returns trigger language plpgsql as $f$
      begin raise exception 'forced audit failure (test)'; end $f$;
      create trigger ${fn} before insert on public.audit_events for each row
      when (new.action like 'consent.%' and new.entity_id = '${childId}') execute function public.${fn}();`);
    try {
      const { consents, withdraw } = await routes();
      as(guardianA);
      const res = await consents.POST(
        post("http://localhost/x", { feature: "ai_extraction", consent_document_id: await docId("ai_extraction"), agree: true }),
        ctx({ id: childId }),
      );
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "Could not save. Please try again." });
      const w = await withdraw.POST(post("http://localhost/x"), ctx({ id: childId, feature: "ai_extraction" }));
      expect(w.status).toBe(503);
    } finally {
      await sql.unsafe(`drop trigger if exists ${fn} on public.audit_events; drop function if exists public.${fn}();`);
    }
    const rows = await sql`select 1 from consent_records where child_id = ${childId}`;
    expect(rows).toHaveLength(0);
  });

  it("NFR-2: RLS lets a guardian read only their own children's consent rows", async () => {
    const mine = await addChild(guardianA);
    const theirs = await addChild(guardianB);
    for (const [childId, g] of [
      [mine, guardianA],
      [theirs, guardianB],
    ] as const) {
      const [link] = await sql<{ id: string }[]>`select id from guardian_links where child_id = ${childId}`;
      await world.grant(childId, g, link.id, ["ai_extraction"]);
    }
    const rows = await sql.begin(async (tx) => {
      await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: guardianA.id, role: "authenticated" })}, true)`;
      await tx`set local role authenticated`;
      const seen = await tx<{ child_id: string }[]>`select child_id from consent_records where child_id in (${mine}, ${theirs})`;
      const denied = await tx
        .savepoint((sp) => sp`insert into consent_records (child_id, feature, action) values (${mine}, 'ai_extraction', 'withdrawn')`)
        .catch((e: Error) => e);
      return { seen, denied };
    });
    expect(rows.seen.map((r) => r.child_id)).toEqual([mine]);
    expect(rows.denied).toBeInstanceOf(Error);
  });
});
