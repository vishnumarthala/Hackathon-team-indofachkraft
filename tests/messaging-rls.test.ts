// Ticket 027 NFR-1/NFR-2/FR-1/FR-5: Row Level Security is the browser's only path to messages, so it is proven
// with real `authenticated` JWTs (password sign-in through Supabase Auth, then PostgREST with the anon key) and
// never with the service role. Realtime delivery is proven at the database layer the Realtime server uses:
// wal2json changes from a logical slot run through `realtime.apply_rls` (the core of `realtime.list_changes`),
// which evaluates our select policy per subscriber exactly as the server does for `postgres_changes`, so a revoked guardian link / assignment / membership receives no further
// inserts. Needs the local Supabase stack (DATABASE_URL + API). Synthetic data only; removed afterwards.
import { randomUUID } from "node:crypto";
import { loadEnvConfig } from "@next/env";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildMessagingWorld, purgeThreadEvents, type MessagingWorld } from "./helpers/messaging";
import { createWorld, type TestUser } from "./helpers/world";

loadEnvConfig(process.cwd(), false, { info: () => {}, error: () => {} });
const enabled = Boolean(process.env.DATABASE_URL) && process.env.SKIP_DB_TESTS !== "1";
const URL = process.env.NEXT_PUBLIC_SUPABASE_URL as string;
const ANON = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY) as string;

describe.skipIf(!enabled)("messaging RLS and Realtime authorisation (database, real JWTs)", { timeout: 180_000 }, () => {
  let sql: Sql;
  /** One dedicated connection: the temporary replication slot lives in its session. */
  let rt: Sql;
  let db: ReturnType<typeof import("@/lib/db").supabaseAdmin>;
  let world: ReturnType<typeof createWorld>;
  let w: MessagingWorld;
  let threadId: string;
  const slot = `t027_rt_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const clients = new Map<string, SupabaseClient>();
  const subs = new Map<string, string>();
  let anon: SupabaseClient;

  async function signIn(u: TestUser): Promise<SupabaseClient> {
    const password = `t027-${randomUUID()}`;
    const { error: pwError } = await db.auth.admin.updateUserById(u.id, { password });
    if (pwError) throw new Error(pwError.message);
    const client = createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await client.auth.signInWithPassword({ email: u.email, password });
    if (error || !data.session) throw new Error(`sign-in failed: ${error?.message}`);
    // A real user JWT, not the service role.
    const claims = JSON.parse(Buffer.from(data.session.access_token.split(".")[1], "base64url").toString());
    expect(claims).toMatchObject({ sub: u.id, role: "authenticated" });
    return client;
  }
  const client = (u: TestUser) => clients.get(u.id) as SupabaseClient;

  async function visible(u: TestUser) {
    const c = client(u);
    const [threads, messages, reads] = await Promise.all([
      c.from("message_threads").select("id").eq("id", threadId),
      c.from("messages").select("id, body").eq("thread_id", threadId),
      c.from("thread_reads").select("user_id").eq("thread_id", threadId),
    ]);
    for (const r of [threads, messages, reads]) expect(r.error).toBeNull();
    return { threads: threads.data?.length ?? 0, messages: messages.data?.length ?? 0, reads: (reads.data ?? []).map((r) => r.user_id) };
  }

  async function sendAs(u: TestUser, body: string): Promise<string> {
    const [{ out }] = await sql<{ out: { result: string; message: { id: string } } }[]>`
      select public.send_thread_message(${threadId}, ${u.id}, ${body}, ${randomUUID()}) as out`;
    expect(out.result).toBe("created");
    return out.message.id;
  }

  /** Subscription ids that Realtime would deliver the insert of `messageId` to. */
  async function deliveredTo(messageId: string): Promise<string[]> {
    // The body of `realtime.list_changes` (Realtime's polling query) without its superuser-only
    // `SET log_min_messages`: wal2json changes of the publication's tables, each run through `realtime.apply_rls`.
    const rows = await rt<{ wal: { type?: string; record?: { id?: string } } | null; subscription_ids: string[] | null; errors: string[] | null }[]>`
      with changes as (
        select x.data from pg_logical_slot_get_changes(${slot}, null, 10000,
          'include-pk', 'true', 'include-transaction', 'false', 'include-timestamp', 'true',
          'include-type-oids', 'true', 'format-version', '2', 'actions', 'insert,update,delete',
          'add-tables', realtime.quote_wal2json('public.messages'::regclass)) x
      )
      select r.wal, r.subscription_ids, r.errors
      from changes, realtime.apply_rls(wal := changes.data::jsonb, max_record_bytes := 1048576) r(wal, is_rls_enabled, subscription_ids, errors)`;
    const hits = rows.filter((r) => r.wal?.record?.id === messageId);
    expect(hits.length, "the insert reached the Realtime publication").toBeGreaterThan(0);
    for (const h of hits) expect(h.errors ?? []).toEqual([]);
    return hits.flatMap((h) => h.subscription_ids ?? []);
  }
  const subOf = (u: TestUser) => subs.get(u.id) as string;

  beforeAll(async () => {
    sql = postgres(process.env.DATABASE_URL as string, { max: 3, prepare: false, onnotice: () => {} });
    rt = postgres(process.env.DATABASE_URL as string, { max: 1, prepare: false, onnotice: () => {}, idle_timeout: 0 });
    db = (await import("@/lib/db")).supabaseAdmin();
    world = createWorld(sql, db, "t027r");
    w = await buildMessagingWorld(sql, world);
    const [{ out }] = await sql<{ out: { result: string; thread: { id: string } } }[]>`
      select public.create_message_thread(${w.caseA}, ${w.guardianA.id}, 't027 rls thread', 'first (synthetic)', ${randomUUID()}) as out`;
    expect(out.result).toBe("created");
    threadId = out.thread.id;
    for (const u of [w.guardianA, w.guardianA2, w.guardianB, w.ownerA, w.assignedA, w.assigned3A, w.unassignedA, w.ownerB]) {
      clients.set(u.id, await signIn(u));
    }
    anon = createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });

    await rt`select pg_create_logical_replication_slot(${slot}, 'wal2json', true)`;
    // What the Realtime server stores for `postgres_changes` INSERT on messages filtered by thread_id, per user.
    for (const u of [w.guardianA, w.guardianA2, w.guardianB, w.assignedA, w.assigned3A, w.unassignedA, w.ownerB]) {
      const id = randomUUID();
      await rt`
        insert into realtime.subscription (subscription_id, entity, filters, claims, action_filter)
        values (${id}, 'public.messages'::regclass,
                array[('thread_id', 'eq', ${threadId}, false)::realtime.user_defined_filter],
                ${rt.json({ sub: u.id, role: "authenticated", aud: "authenticated" })}, 'INSERT')`;
      subs.set(u.id, id);
    }
  });

  afterAll(async () => {
    if (rt) {
      if (subs.size) await rt`delete from realtime.subscription where subscription_id in ${rt([...subs.values()])}`;
      await rt.end({ timeout: 5 });
    }
    for (const c of clients.values()) await c.auth.signOut().catch(() => {});
    if (world) {
      await purgeThreadEvents(sql, [w.caseA, w.caseB, w.caseNoGuardian]);
      await world.cleanup();
    }
    await sql?.end({ timeout: 5 });
  });

  it("participants read the thread with their own JWT; outsiders and anon read nothing", async () => {
    for (const u of [w.guardianA, w.guardianA2, w.ownerA, w.assignedA, w.assigned3A]) {
      const v = await visible(u);
      expect(v.threads, u.email).toBe(1);
      expect(v.messages, u.email).toBe(1);
    }
    for (const u of [w.unassignedA, w.ownerB, w.guardianB]) expect(await visible(u), u.email).toEqual({ threads: 0, messages: 0, reads: [] });
    for (const table of ["message_threads", "messages", "thread_reads"]) {
      const r = await anon.from(table).select("*").limit(5);
      expect(r.data ?? [], table).toEqual([]);
    }
    // Read markers: only your own.
    expect((await visible(w.guardianA)).reads).toEqual([w.guardianA.id]);
    expect((await visible(w.assignedA)).reads).toEqual([]);
  });

  it("nobody writes through the API with anon or user JWTs (server routes only)", async () => {
    const row = { thread_id: threadId, sender_id: w.guardianA.id, sender_kind: "guardian", body: "direct (synthetic)", client_id: randomUUID() };
    for (const c of [anon, client(w.guardianA), client(w.ownerA)]) {
      const ins = await c.from("messages").insert(row).select();
      expect(ins.error, "insert").not.toBeNull();
      const upd = await c.from("messages").update({ body: "changed" }).eq("thread_id", threadId).select();
      expect(upd.data ?? []).toEqual([]);
      const del = await c.from("messages").delete().eq("thread_id", threadId).select();
      expect(del.data ?? []).toEqual([]);
      const th = await c.from("message_threads").insert({ case_id: w.caseA, org_id: w.orgA, child_id: w.childId, subject: "x" }).select();
      expect(th.error, "thread insert").not.toBeNull();
      const rd = await c.from("thread_reads").upsert({ thread_id: threadId, user_id: w.guardianA.id }).select();
      expect(rd.error, "read insert").not.toBeNull();
      // Write functions are service-role only.
      const fn = await c.rpc("send_thread_message", { p_thread: threadId, p_user: w.guardianA.id, p_body: "x", p_client_id: randomUUID() });
      expect(fn.error, "rpc").not.toBeNull();
    }
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from messages where thread_id = ${threadId}`;
    expect(n).toBe(1);
    const [{ body }] = await sql<{ body: string }[]>`select body from messages where thread_id = ${threadId}`;
    expect(body).toBe("first (synthetic)");
  });

  it("Realtime: an insert is delivered only to subscribers who may read it", async () => {
    const id = await sendAs(w.assignedA, "realtime one (synthetic)");
    const to = await deliveredTo(id);
    for (const u of [w.guardianA, w.guardianA2, w.assignedA, w.assigned3A]) expect(to, u.email).toContain(subOf(u));
    for (const u of [w.unassignedA, w.ownerB, w.guardianB]) expect(to, u.email).not.toContain(subOf(u));
  });

  it("NFR-2: revoking the guardian link, the assignment or the membership cuts API reads and Realtime at once", async () => {
    // Revoke three different ways.
    await sql`update guardian_links set status = 'revoked', revoked_at = now() where child_id = ${w.childId} and user_id = ${w.guardianA2.id}`;
    const [{ id: assignmentId }] = await sql<{ id: string }[]>`
      select id from case_assignments where case_id = ${w.caseA} and user_id = ${w.assignedA.id} and removed_at is null`;
    const [{ removed }] = await sql<{ removed: unknown }[]>`select public.remove_case_assignment(${w.caseA}, ${assignmentId}, ${w.ownerA.id}) as removed`;
    expect(removed).toBeTruthy();
    await sql`update org_members set status = 'revoked', revoked_at = now() where org_id = ${w.orgA} and user_id = ${w.assigned3A.id}`;

    // Same sessions (JWTs issued before the revocation): nothing readable on the next request.
    for (const u of [w.guardianA2, w.assignedA, w.assigned3A]) expect(await visible(u), u.email).toEqual({ threads: 0, messages: 0, reads: [] });
    expect((await visible(w.guardianA)).messages).toBe(2);

    // The next event: guardian A writes; only remaining participants receive it.
    const id = await sendAs(w.guardianA, "after revocation (synthetic)");
    const to = await deliveredTo(id);
    expect(to).toContain(subOf(w.guardianA));
    for (const u of [w.guardianA2, w.assignedA, w.assigned3A, w.unassignedA, w.ownerB, w.guardianB]) expect(to, u.email).not.toContain(subOf(u));

    // The server's own rule agrees (API routes use thread_access_level).
    for (const u of [w.guardianA2, w.assignedA, w.assigned3A]) {
      const [{ level }] = await sql<{ level: string | null }[]>`select public.thread_access_level(${u.id}, ${threadId}) as level`;
      expect(level, u.email).toBeNull();
    }
    const [{ owner }] = await sql<{ owner: string | null }[]>`select public.thread_access_level(${w.ownerA.id}, ${threadId}) as owner`;
    expect(owner).toBe("manage");
  });
});
