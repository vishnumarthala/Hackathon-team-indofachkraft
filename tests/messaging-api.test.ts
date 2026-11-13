// Ticket 027 FR-2/FR-3/FR-6/NFR-3: messaging routes against the local database (DATABASE_URL). Authorisation
// matrix (guardian / assigned / unassigned / owner / other org / other family / anonymous), idempotent client_id,
// rate limit 429, archived 409, 15-minute delete window, attachments under 023's rules, the outbox event written in
// the same transaction (forced enqueue failure rolls the message back), fan-out recipients re-checked at delivery
// (read marker, revoked link, sender) with generic text only, and no message text in audit rows or logs. Also the
// FR-5 sync controller (Realtime, else polling every 15 s; 404 -> access lost) with fake timers.
// Synthetic data only; everything is removed afterwards.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { loadEnvConfig } from "@next/env";
import postgres, { type Sql } from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { messagingErrorKey, mergeMessages } from "@/components/messaging/client";
import { startThreadSync, type Subscribe } from "@/components/messaging/threadSync";
import { DELETED_BODY } from "@/lib/messaging/constants";
import type { MessageView } from "@/lib/messaging/types";
import { purgeTestAudit } from "./helpers/audit";
import { buildMessagingWorld, familyDocument, providerDocument, purgeThreadEvents, type MessagingWorld } from "./helpers/messaging";
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

describe("every messaging handler passes a gate first (static scan)", () => {
  const files = [...routeFiles(path.join(ROOT, "app/api/threads")), ...routeFiles(path.join(ROOT, "app/api/messages"))];
  it("finds the routes", () => {
    expect(files.map((f) => path.relative(ROOT, f)).sort()).toEqual([
      "app/api/messages/[id]/route.ts",
      "app/api/threads/[id]/archive/route.ts",
      "app/api/threads/[id]/messages/route.ts",
      "app/api/threads/[id]/read/route.ts",
      "app/api/threads/route.ts",
    ]);
  });
  it.each(files.map((f) => [path.relative(ROOT, f)]))("%s", (rel) => {
    const source = readFileSync(path.join(ROOT, rel), "utf8");
    const handlers = [...source.matchAll(/export async function (GET|POST|PATCH|DELETE)\(([^)]*)\)[^{]*\{\s*([^\n]*)\n\s*([^\n]*)\n\s*([^\n]*)/g)];
    expect(handlers.length).toBeGreaterThan(0);
    for (const [, method, args, first, second, third] of handlers) {
      const lines = args.includes("params") ? [second, third] : [first, second];
      if (args.includes("params")) expect(first, `${rel} ${method}`).toMatch(/await params/);
      expect(lines[0], `${rel} ${method}`).toMatch(/await (requireThreadAccess|requireMessageAccess|requireMessagingUser)\(/);
      expect(lines[1], `${rel} ${method}`).toMatch(/instanceof Response\) return/);
    }
  });
});

describe("FR-5 live updates: Realtime first, polling every 15 s as the fallback", () => {
  type Handlers = Parameters<Subscribe>[0];
  const flush = () => vi.advanceTimersByTimeAsync(0);
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function fakeChannel() {
    const channel = { handlers: null as Handlers | null, unsubscribed: 0 };
    const subscribe: Subscribe = (h) => {
      channel.handlers = h;
      return () => {
        channel.unsubscribed += 1;
      };
    };
    return { channel, subscribe };
  }

  it("polls every 15 s when Realtime is not available (no client)", async () => {
    const refresh = vi.fn(async () => "ok" as const);
    const statuses: string[] = [];
    const sync = startThreadSync({ refresh, subscribe: () => null, onStatus: (s) => statuses.push(s) });
    expect(sync.status()).toBe("polling");
    await vi.advanceTimersByTimeAsync(45_000);
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(statuses).toEqual(["polling"]);
    sync.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it("CHANNEL_ERROR (local stack without Realtime): checks access at once, unsubscribes, then polls", async () => {
    const refresh = vi.fn(async () => "ok" as const);
    const { channel, subscribe } = fakeChannel();
    const sync = startThreadSync({ refresh, subscribe });
    expect(sync.status()).toBe("connecting");
    channel.handlers?.onStatus("CHANNEL_ERROR");
    await flush();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(sync.status()).toBe("polling");
    expect(channel.unsubscribed).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(refresh).toHaveBeenCalledTimes(3);
    sync.stop();
  });

  it("no answer from Realtime within 10 s -> polling", async () => {
    const refresh = vi.fn(async () => "ok" as const);
    const { channel, subscribe } = fakeChannel();
    const sync = startThreadSync({ refresh, subscribe });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sync.status()).toBe("polling");
    expect(channel.unsubscribed).toBe(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    sync.stop();
  });

  it("SUBSCRIBED: changes refresh through the API, no 15 s polling, a 60 s access check", async () => {
    const refresh = vi.fn(async () => "ok" as const);
    const { channel, subscribe } = fakeChannel();
    const sync = startThreadSync({ refresh, subscribe });
    channel.handlers?.onStatus("SUBSCRIBED");
    await flush();
    expect(sync.status()).toBe("live");
    expect(refresh).toHaveBeenCalledTimes(1);
    channel.handlers?.onChange();
    await flush();
    expect(refresh).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(refresh).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(refresh).toHaveBeenCalledTimes(3);
    sync.stop();
    expect(channel.unsubscribed).toBe(1);
  });

  it("revocation: a 404 on any refresh shows `lost` and stops polling and the channel", async () => {
    let answer: "ok" | "lost" = "ok";
    const refresh = vi.fn(async () => answer);
    const { channel, subscribe } = fakeChannel();
    const statuses: string[] = [];
    const sync = startThreadSync({ refresh, subscribe, onStatus: (s) => statuses.push(s) });
    channel.handlers?.onStatus("CHANNEL_ERROR");
    await vi.advanceTimersByTimeAsync(15_000);
    answer = "lost";
    await vi.advanceTimersByTimeAsync(15_000);
    expect(sync.status()).toBe("lost");
    expect(statuses).toEqual(["polling", "lost"]);
    const calls = refresh.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(refresh.mock.calls.length).toBe(calls);
    // Revoked while Realtime was live: the 60 s check (or the next change) finds out.
    const live = fakeChannel();
    const sync2 = startThreadSync({ refresh: async () => "lost", subscribe: live.subscribe });
    live.channel.handlers?.onStatus("SUBSCRIBED");
    await flush();
    expect(sync2.status()).toBe("lost");
    expect(live.channel.unsubscribed).toBe(1);
  });

  it("maps API errors to translated keys and merges pages by id", () => {
    expect(messagingErrorKey(429)).toBe("tooFast");
    expect(messagingErrorKey(409, "This conversation is archived")).toBe("archived");
    expect(messagingErrorKey(409, "Messages can only be deleted within 15 minutes")).toBe("tooLate");
    expect(messagingErrorKey(422, "No parent account is linked to this child yet")).toBe("noGuardian");
    expect(messagingErrorKey(422, "Everyone in this conversation must be able to see this document")).toBe("notAttachable");
    expect(messagingErrorKey(403, "You can only delete your own messages")).toBe("notOwn");
    expect(messagingErrorKey(500)).toBe("failed");
    const m = (id: string, at: string, body = "b") => ({ id, created_at: at, body }) as MessageView;
    const merged = mergeMessages([m("b", "2026-11-13T10:01:00Z"), m("a", "2026-11-13T10:00:00Z")], [m("b", "2026-11-13T10:01:00Z", "deleted"), m("c", "2026-11-13T10:02:00Z")]);
    expect(merged.map((x) => `${x.id}:${x.body}`)).toEqual(["a:b", "b:deleted", "c:b"]);
  });
});

describe.skipIf(!enabled)("messaging API (database)", { timeout: 180_000 }, () => {
  let sql: Sql;
  let db: ReturnType<typeof import("@/lib/db").supabaseAdmin>;
  let world: ReturnType<typeof createWorld>;
  let w: MessagingWorld;
  const logged: string[] = [];
  const SECRET = `t027 synthetic sleep note ${Math.random().toString(36).slice(2, 10)}`;

  const routes = {
    threads: () => import("@/app/api/threads/route"),
    messages: () => import("@/app/api/threads/[id]/messages/route"),
    read: () => import("@/app/api/threads/[id]/read/route"),
    archive: () => import("@/app/api/threads/[id]/archive/route"),
    message: () => import("@/app/api/messages/[id]/route"),
  };
  const as = (u: TestUser | null) => {
    session.user = u;
  };
  const cid = () => crypto.randomUUID();

  async function listThreads(u: TestUser | null, query = "") {
    as(u);
    return (await routes.threads()).GET(new Request(`http://localhost/api/threads${query}`));
  }
  async function createThread(u: TestUser, body: Record<string, unknown>) {
    as(u);
    return (await routes.threads()).POST(post("http://localhost/api/threads", body));
  }
  async function getMessages(u: TestUser | null, threadId: string, query = "") {
    as(u);
    return (await routes.messages()).GET(new Request(`http://localhost/api/threads/${threadId}/messages${query}`), ctx({ id: threadId }));
  }
  async function send(u: TestUser, threadId: string, body: Record<string, unknown>) {
    as(u);
    return (await routes.messages()).POST(post(`http://localhost/api/threads/${threadId}/messages`, body), ctx({ id: threadId }));
  }
  async function markRead(u: TestUser, threadId: string) {
    as(u);
    return (await routes.read()).POST(post(`http://localhost/x`), ctx({ id: threadId }));
  }
  async function archive(u: TestUser, threadId: string) {
    as(u);
    return (await routes.archive()).POST(post(`http://localhost/x`), ctx({ id: threadId }));
  }
  async function remove(u: TestUser, messageId: string) {
    as(u);
    return (await routes.message()).DELETE(post(`http://localhost/x`, undefined, "DELETE"), ctx({ id: messageId }));
  }
  async function newThread(u: TestUser, subject: string, caseId = w.caseA) {
    const res = await createThread(u, { case_id: caseId, subject, body: `${SECRET} (${subject})`, client_id: cid() });
    expect(res.status).toBe(201);
    return (await res.json()) as { thread: { id: string }; message: MessageView };
  }

  beforeAll(async () => {
    sql = postgres(process.env.DATABASE_URL as string, { max: 4, prepare: false, onnotice: () => {} });
    db = (await import("@/lib/db")).supabaseAdmin();
    world = createWorld(sql, db, "t027a");
    w = await buildMessagingWorld(sql, world);
    for (const level of ["log", "info", "warn", "error"] as const) {
      const original = console[level].bind(console);
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
        if (level === "error") original(...args);
      });
    }
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    if (world) {
      const cases = [w.caseA, w.caseB, w.caseNoGuardian];
      await purgeThreadEvents(sql, cases);
      await world.cleanup();
      // 041: audit rows survive case deletion and are append-only; remove this suite's synthetic messaging rows
      // through the documented maintenance path.
      await purgeTestAudit(sql, (tx) => tx`
        delete from audit_events where case_ref in ${tx(cases)}
          and action in ('thread.created', 'message.sent', 'message.deleted', 'thread.archived')`);
    }
    await sql?.end({ timeout: 5 });
  });

  it("E-1: a guardian starts a thread; the outbox event and audit rows are written with ids only", async () => {
    const res = await createThread(w.guardianA, { case_id: w.caseA, subject: "  t027 Sleep question  ", body: SECRET, client_id: cid() });
    expect(res.status).toBe(201);
    const { thread, message } = (await res.json()) as { thread: Record<string, string>; message: MessageView };
    expect(thread).toMatchObject({ subject: "t027 Sleep question", case_id: w.caseA, org_id: w.orgA, child_id: w.childId, archived_at: null });
    expect(message).toMatchObject({ body: SECRET, sender_kind: "guardian", sender_name: "Meera (synthetic)", own: true, can_delete: true, document: null });

    const events = await sql<{ topic: string; aggregate_type: string; aggregate_id: string; payload: unknown; dedup_key: string; delay: number }[]>`
      select topic, aggregate_type, aggregate_id, payload, dedup_key,
             extract(epoch from deliver_after - created_at)::int as delay
      from outbox_events where aggregate_type = 'thread' and aggregate_id = ${thread.id}`;
    expect(events).toEqual([
      { topic: "message.created", aggregate_type: "thread", aggregate_id: thread.id, payload: { message_id: message.id }, dedup_key: `message:${message.id}`, delay: 120 },
    ]);
    const audits = await sql<{ action: string; actor: string; actor_user_id: string; details: Record<string, unknown> }[]>`
      select action, actor, actor_user_id, details from audit_events where case_id = ${w.caseA} and action in ('thread.created', 'message.sent') order by id`;
    expect(audits).toEqual([
      { action: "thread.created", actor: "parent", actor_user_id: w.guardianA.id, details: { org_id: w.orgA, child_id: w.childId } },
      { action: "message.sent", actor: "parent", actor_user_id: w.guardianA.id, details: { thread_id: thread.id, document_id: null } },
    ]);
  });

  it("FR-2: access matrix for list and read (404 for everyone outside the thread)", async () => {
    const { thread } = await newThread(w.guardianA, "t027 matrix");
    for (const u of [w.guardianA, w.guardianA2, w.assignedA, w.assigned3A, w.ownerA]) {
      const res = await getMessages(u, thread.id);
      expect(res.status, u.email).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const page = (await res.json()) as { messages: MessageView[]; has_more: boolean };
      expect(page.messages.map((m) => m.body)).toEqual([`${SECRET} (t027 matrix)`]);
    }
    for (const u of [w.unassignedA, w.ownerB, w.guardianB]) expect((await getMessages(u, thread.id)).status, u.email).toBe(404);
    expect((await getMessages(null, thread.id)).status).toBe(401);
    expect((await getMessages(w.ownerA, "not-a-uuid")).status).toBe(404);

    const provider = (await (await listThreads(w.assignedA, `?case_id=${w.caseA}`)).json()) as { threads: { id: string; unread: number; org_name: string; case_label: string }[] };
    expect(provider.threads.find((x) => x.id === thread.id)).toMatchObject({ unread: 1, org_name: expect.stringContaining("Centre A") });
    const family = (await (await listThreads(w.guardianA, `?child_id=${w.childId}`)).json()) as { threads: { id: string; unread: number; case_label?: string }[] };
    const mine = family.threads.find((x) => x.id === thread.id);
    expect(mine).toMatchObject({ unread: 0 });
    expect(mine).not.toHaveProperty("case_label");
    expect(((await (await listThreads(w.unassignedA)).json()) as { threads: unknown[] }).threads).toEqual([]);
    expect(((await (await listThreads(w.ownerB)).json()) as { threads: unknown[] }).threads).toEqual([]);
    expect((await listThreads(w.unassignedA, `?case_id=${w.caseA}`)).status).toBe(404);
    expect((await listThreads(w.guardianB, `?child_id=${w.childId}`)).status).toBe(404);
    expect((await listThreads(w.guardianB, `?case_id=${w.caseA}`)).status).toBe(404);
    expect((await listThreads(null)).status).toBe(401);

    // Writes are gated the same way.
    expect((await send(w.unassignedA, thread.id, { body: "x", client_id: cid() })).status).toBe(404);
    expect((await send(w.ownerB, thread.id, { body: "x", client_id: cid() })).status).toBe(404);
    expect((await createThread(w.ownerB, { case_id: w.caseA, subject: "s", body: "x", client_id: cid() })).status).toBe(404);
    expect((await createThread(w.guardianB, { case_id: w.caseA, subject: "s", body: "x", client_id: cid() })).status).toBe(404);
    expect((await createThread(w.unassignedA, { case_id: w.caseA, subject: "s", body: "x", client_id: cid() })).status).toBe(404);
  });

  it("FR-2: provider reply, role label data, read marker and unread counts", async () => {
    const { thread } = await newThread(w.guardianA, "t027 reply");
    const reply = await send(w.assignedA, thread.id, { body: `${SECRET} reply`, client_id: cid() });
    expect(reply.status).toBe(201);
    const { message } = (await reply.json()) as { message: MessageView };
    expect(message).toMatchObject({ sender_kind: "provider", sender_name: "Dr Rao (synthetic)", discipline_label: "Speech therapist" });

    const unread = async () =>
      ((await (await listThreads(w.guardianA, `?child_id=${w.childId}`)).json()) as { threads: { id: string; unread: number }[] }).threads.find((x) => x.id === thread.id)?.unread;
    expect(await unread()).toBe(1);
    expect((await markRead(w.guardianA, thread.id)).status).toBe(200);
    expect(await unread()).toBe(0);
    expect((await markRead(w.unassignedA, thread.id)).status).toBe(404);
  });

  it("FR-2: a case without a linked parent -> 422; validation -> 400", async () => {
    const res = await createThread(w.ownerA, { case_id: w.caseNoGuardian, subject: "t027 none", body: "x", client_id: cid() });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "No parent account is linked to this child yet" });
    expect((await createThread(w.guardianA, { case_id: w.caseA, subject: "", body: "x", client_id: cid() })).status).toBe(400);
    expect((await createThread(w.guardianA, { case_id: w.caseA, subject: "s".repeat(121), body: "x", client_id: cid() })).status).toBe(400);
    expect((await createThread(w.guardianA, { case_id: w.caseA, subject: "s", body: "x".repeat(4001), client_id: cid() })).status).toBe(400);
    expect((await createThread(w.guardianA, { case_id: w.caseA, subject: "s", body: "   ", client_id: cid() })).status).toBe(400);
    expect((await createThread(w.guardianA, { case_id: w.caseA, subject: "s", body: "x", client_id: "nope" })).status).toBe(400);
  });

  it("E-4: the same client_id stores one message (thread and message create)", async () => {
    const client_id = cid();
    const first = await createThread(w.guardianA, { case_id: w.caseA, subject: "t027 idem", body: "hello (synthetic)", client_id });
    expect(first.status).toBe(201);
    const again = await createThread(w.guardianA, { case_id: w.caseA, subject: "t027 idem", body: "hello (synthetic)", client_id });
    expect(again.status).toBe(200);
    const a = (await first.json()) as { thread: { id: string }; message: { id: string } };
    const b = (await again.json()) as { thread: { id: string }; message: { id: string } };
    expect(b).toMatchObject({ thread: { id: a.thread.id }, message: { id: a.message.id } });
    expect((await sql`select id from message_threads where case_id = ${w.caseA} and subject = 't027 idem'`).length).toBe(1);

    const msgClient = cid();
    const s1 = await send(w.assignedA, a.thread.id, { body: "once (synthetic)", client_id: msgClient });
    const s2 = await send(w.assignedA, a.thread.id, { body: "once (synthetic)", client_id: msgClient });
    expect([s1.status, s2.status]).toEqual([201, 200]);
    expect(((await s2.json()) as { message: { id: string } }).message.id).toBe(((await s1.json()) as { message: { id: string } }).message.id);
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from messages where sender_id = ${w.assignedA.id} and client_id = ${msgClient}`;
    expect(n).toBe(1);
    const [{ e }] = await sql<{ e: number }[]>`
      select count(*)::int as e from outbox_events where aggregate_id = ${a.thread.id} and aggregate_type = 'thread'`;
    expect(e).toBe(2);
    // The same client_id cannot be reused for another conversation.
    const other = await newThread(w.guardianA, "t027 idem other");
    expect((await send(w.assignedA, other.thread.id, { body: "x", client_id: msgClient })).status).toBe(409);
  });

  it("FR-2: 30 messages per user per 5 minutes -> 429 (replays still answer 200)", async () => {
    const { thread, message } = await newThread(w.assigned3A, "t027 rate");
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from messages where sender_id = ${w.assigned3A.id} and created_at > now() - interval '5 minutes'`;
    await sql`
      insert into messages (thread_id, sender_id, sender_kind, body, client_id)
      select ${thread.id}, ${w.assigned3A.id}, 'provider', 'filler (synthetic)', gen_random_uuid() from generate_series(1, ${30 - n})`;
    const res = await send(w.assigned3A, thread.id, { body: "one too many (synthetic)", client_id: cid() });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "You're sending messages too fast" });
    expect((await createThread(w.assigned3A, { case_id: w.caseA, subject: "s", body: "x", client_id: cid() })).status).toBe(429);
    const [{ client_id }] = await sql<{ client_id: string }[]>`select client_id from messages where id = ${message.id}`;
    expect((await send(w.assigned3A, thread.id, { body: "x", client_id })).status).toBe(200);
    // Other users are not affected; after the window the sender can write again.
    expect((await send(w.assignedA, thread.id, { body: "fine (synthetic)", client_id: cid() })).status).toBe(201);
    await sql`update messages set created_at = created_at - interval '6 minutes' where sender_id = ${w.assigned3A.id}`;
    expect((await send(w.assigned3A, thread.id, { body: "later (synthetic)", client_id: cid() })).status).toBe(201);
  });

  it("FR-2: concurrent senders in one thread all succeed (no lock-order deadlock)", async () => {
    const { thread } = await newThread(w.guardianA, "t027 concurrent");
    const senders = [w.guardianA, w.assignedA, w.guardianA2, w.ownerA];
    const results = await Promise.all(
      senders.flatMap((u) =>
        [1, 2].map(async () => {
          const [{ out }] = await sql<{ out: { result: string } }[]>`
            select public.send_thread_message(${thread.id}, ${u.id}, 'concurrent (synthetic)', ${cid()}) as out`;
          return out.result;
        }),
      ),
    );
    expect(results).toEqual(Array(8).fill("created"));
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from messages where thread_id = ${thread.id}`;
    expect(n).toBe(9);
  });

  it("FR-2: delete own message within 15 minutes; body replaced for everyone; notification cancelled", async () => {
    const { thread, message } = await newThread(w.guardianA, "t027 delete");
    expect((await remove(w.assignedA, message.id)).status).toBe(403);
    expect((await remove(w.unassignedA, message.id)).status).toBe(404);
    const res = await remove(w.guardianA, message.id);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { message: MessageView }).message).toMatchObject({ deleted: true, body: DELETED_BODY, can_delete: false });
    const seen = (await (await getMessages(w.assignedA, thread.id)).json()) as { messages: MessageView[] };
    expect(seen.messages.find((m) => m.id === message.id)).toMatchObject({ deleted: true, body: DELETED_BODY });
    const [stored] = await sql<{ body: string }[]>`select body from messages where id = ${message.id}`;
    expect(stored.body).toBe(DELETED_BODY);
    const [event] = await sql<{ status: string }[]>`select status from outbox_events where dedup_key = ${`message:${message.id}`}`;
    expect(event.status).toBe("cancelled");
    const [audit] = await sql<{ details: unknown }[]>`select details from audit_events where action = 'message.deleted' and entity_id = ${message.id}`;
    expect(audit.details).toEqual({ thread_id: thread.id });

    const old = await send(w.guardianA, thread.id, { body: "older (synthetic)", client_id: cid() });
    const oldId = ((await old.json()) as { message: { id: string } }).message.id;
    await sql`update messages set created_at = now() - interval '16 minutes' where id = ${oldId}`;
    const late = await remove(w.guardianA, oldId);
    expect(late.status).toBe(409);
    expect(await late.json()).toEqual({ error: "Messages can only be deleted within 15 minutes" });
  });

  it("FR-6: owners/admins archive; archived threads are read-only (409)", async () => {
    const { thread, message } = await newThread(w.guardianA, "t027 archive");
    expect((await archive(w.assignedA, thread.id)).status).toBe(403);
    expect((await archive(w.guardianA, thread.id)).status).toBe(403);
    expect((await archive(w.ownerB, thread.id)).status).toBe(404);
    const res = await archive(w.ownerA, thread.id);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { thread: { archived_at: string | null } }).thread.archived_at).not.toBeNull();
    const blocked = await send(w.guardianA, thread.id, { body: "x", client_id: cid() });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toEqual({ error: "This conversation is archived" });
    expect((await remove(w.guardianA, message.id)).status).toBe(409);
    expect((await getMessages(w.guardianA, thread.id)).status).toBe(200);
    expect((await markRead(w.guardianA, thread.id)).status).toBe(200);
  });

  it("E-4: attachments must be readable by every participant (023 rules)", async () => {
    const { thread } = await newThread(w.guardianA, "t027 attach");
    const visible = await providerDocument(sql, { childId: w.childId, caseId: w.caseA, orgId: w.orgA, userId: w.assignedA.id, visible: true, title: "t027 visible report" });
    const hidden = await providerDocument(sql, { childId: w.childId, caseId: w.caseA, orgId: w.orgA, userId: w.assignedA.id, visible: false, title: "t027 provider-only" });
    const shared = await familyDocument(sql, { childId: w.childId, userId: w.guardianA.id, title: "t027 school letter", shareWithOrg: w.orgA });
    const unshared = await familyDocument(sql, { childId: w.childId, userId: w.guardianA.id, title: "t027 private letter" });
    const otherOrg = await providerDocument(sql, { childId: w.childId, caseId: w.caseB, orgId: w.orgB, userId: w.ownerB.id, visible: true, title: "t027 org B" });

    const ok = await send(w.assignedA, thread.id, { body: "see attached (synthetic)", client_id: cid(), document_id: visible });
    expect(ok.status).toBe(201);
    const seen = (await (await getMessages(w.guardianA, thread.id)).json()) as { messages: MessageView[] };
    expect(seen.messages.at(-1)?.document).toEqual({
      id: visible, available: true, title: "t027 visible report", file_name: "note.pdf", mime_type: "application/pdf", url: `/api/documents/${visible}/download`,
    });
    expect((await send(w.guardianA, thread.id, { body: "letter (synthetic)", client_id: cid(), document_id: shared })).status).toBe(201);

    for (const doc of [hidden, unshared, otherOrg, crypto.randomUUID()]) {
      const res = await send(doc === unshared ? w.guardianA : w.assignedA, thread.id, { body: "x", client_id: cid(), document_id: doc });
      expect(res.status, doc).toBe(422);
      expect(await res.json()).toEqual({ error: "Everyone in this conversation must be able to see this document" });
    }
    // Later loss of access shows the attachment as unavailable instead of leaking its title.
    await sql`update documents set visible_to_guardian = false where id = ${visible}`;
    const after = (await (await getMessages(w.guardianA, thread.id)).json()) as { messages: MessageView[] };
    expect(after.messages.find((m) => m.document?.id === visible)?.document).toEqual({ id: visible, available: false });
  });

  it("FR-3: message insert and outbox event are atomic (forced enqueue failure rolls the message back)", async () => {
    const { thread } = await newThread(w.guardianA, "t027 atomic");
    expect(thread.id).toMatch(/^[0-9a-f-]{36}$/);
    await sql.unsafe(`
      create or replace function public.t027_fail_enqueue() returns trigger language plpgsql as $$
      begin raise exception 'forced outbox failure'; end $$;
      create trigger t027_fail_enqueue before insert on public.outbox_events for each row
      when (new.aggregate_id = '${thread.id}'::uuid) execute function public.t027_fail_enqueue();`);
    try {
      const before = await sql`select id from messages where thread_id = ${thread.id}`;
      const res = await send(w.assignedA, thread.id, { body: `${SECRET} atomic`, client_id: cid() });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "Could not send. Please try again." });
      expect((await sql`select id from messages where thread_id = ${thread.id}`).length).toBe(before.length);
      const [{ n }] = await sql<{ n: number }[]>`
        select count(*)::int as n from audit_events where action = 'message.sent' and actor_user_id = ${w.assignedA.id} and details ->> 'thread_id' = ${thread.id}`;
      expect(n).toBe(0);
    } finally {
      await sql.unsafe(`drop trigger if exists t027_fail_enqueue on public.outbox_events; drop function if exists public.t027_fail_enqueue();`);
    }
    expect((await send(w.assignedA, thread.id, { body: "works again (synthetic)", client_id: cid() })).status).toBe(201);
  });

  it("E-2 / FR-3: fan-out after 2 minutes to participants who have not read, with generic text only", async () => {
    const { runOutbox } = await import("@/lib/notify/worker");
    const { thread } = await newThread(w.guardianA, "t027 notify");
    await markRead(w.guardianA2, thread.id);
    const emails: string[] = [];
    const deliver = async (messageId: string) => {
      const [event] = await sql<{ id: string }[]>`select id::text as id from outbox_events where dedup_key = ${`message:${messageId}`}`;
      // Nothing is due before deliver_after (2 minutes).
      expect((await runOutbox({ sql, eventIds: [event.id] })).fanned_out).toBe(0);
      await sql`update outbox_events set deliver_after = now() where id = ${event.id}`;
      await runOutbox({
        sql,
        eventIds: [event.id],
        appUrl: "https://app.test",
        senders: {
          email: async (job) => {
            emails.push(`${job.rendered.email?.subject}\n${job.rendered.email?.text}\n${job.rendered.email?.html}`);
            return { status: "sent", providerMessageId: "test" };
          },
          whatsapp: async () => ({ status: "skipped", reason: "whatsapp_not_configured" }),
        },
      });
      return sql<{ recipient_user_id: string; channel: string; status: string; title: string; body: string; link: string }[]>`
        select recipient_user_id, channel, status, title, body, link from notifications where event_id = ${event.id} order by channel`;
    };

    // Provider writes while the parents have the thread closed (guardianA2's marker is older than the message).
    const r1 = await send(w.assignedA, thread.id, { body: `${SECRET} closed`, client_id: cid() });
    const m1 = ((await r1.json()) as { message: { id: string } }).message.id;
    const rows1 = await deliver(m1);
    const recipients1 = [...new Set(rows1.map((r) => r.recipient_user_id))].sort();
    // Guardians, the case lead (owner) and assigned3A; never the sender, never the unassigned member or org B.
    expect(recipients1).toEqual([w.guardianA.id, w.guardianA2.id, w.ownerA.id, w.assigned3A.id].sort());
    const inApp = rows1.find((r) => r.recipient_user_id === w.guardianA.id && r.channel === "in_app");
    expect(inApp).toMatchObject({ status: "sent", title: "New message", body: "You have a new message on DoctorNearMe.", link: `/family/messages/${thread.id}` });
    expect(rows1.find((r) => r.recipient_user_id === w.ownerA.id && r.channel === "in_app")?.link).toBe(`/dashboard/messages/${thread.id}`);
    expect(emails.length).toBeGreaterThan(0);
    for (const e of emails) {
      expect(e).toContain("You have a new message on DoctorNearMe.");
      expect(e).not.toContain(SECRET);
      expect(e).not.toContain("t027 notify");
      expect(e).not.toContain("Dr Rao");
    }

    // Guardian A has the thread open (read marker after the message); guardian A2 lost access before fan-out.
    const r2 = await send(w.assignedA, thread.id, { body: `${SECRET} open`, client_id: cid() });
    const m2 = ((await r2.json()) as { message: { id: string } }).message.id;
    await markRead(w.guardianA, thread.id);
    await sql`update guardian_links set status = 'revoked', revoked_at = now() where child_id = ${w.childId} and user_id = ${w.guardianA2.id}`;
    try {
      const rows2 = await deliver(m2);
      const recipients2 = [...new Set(rows2.map((r) => r.recipient_user_id))];
      expect(recipients2).not.toContain(w.guardianA.id);
      expect(recipients2).not.toContain(w.guardianA2.id);
      expect(recipients2).not.toContain(w.assignedA.id);
    } finally {
      await sql`update guardian_links set status = 'active', revoked_at = null where child_id = ${w.childId} and user_id = ${w.guardianA2.id}`;
    }
    const all = await sql<{ body: string; title: string }[]>`
      select n.body, n.title from notifications n join outbox_events e on e.id = n.event_id
      where e.aggregate_type = 'thread' and e.aggregate_id = ${thread.id}`;
    for (const n of all) expect(`${n.title} ${n.body}`).not.toContain(SECRET);
  });

  it("041: AUDIT_FAIL_ACTIONS hook -> 503 and nothing saved; audit rows are attributed by the 041 trigger", async () => {
    const { thread } = await newThread(w.guardianA, "t027 audit hook");
    vi.stubEnv("AUDIT_FAIL_ACTIONS", "message.sent");
    try {
      const res = await send(w.assignedA, thread.id, { body: "blocked (synthetic)", client_id: cid() });
      expect(res.status).toBe(503);
    } finally {
      vi.unstubAllEnvs();
    }
    expect((await sql`select id from messages where thread_id = ${thread.id} and body = 'blocked (synthetic)'`).length).toBe(0);
    expect((await send(w.assignedA, thread.id, { body: "allowed (synthetic)", client_id: cid() })).status).toBe(201);
    const [row] = await sql<{ actor_role: string; org_id: string; child_id: string; case_ref: string }[]>`
      select actor_role, org_id, child_id, case_ref from audit_events
      where action = 'message.sent' and actor_user_id = ${w.assignedA.id} and details ->> 'thread_id' = ${thread.id}`;
    expect(row).toEqual({ actor_role: "provider", org_id: w.orgA, child_id: w.childId, case_ref: w.caseA });
  });

  it("041 privacy registry: guardian export holds only their child's threads; erasure removes every org's threads", async () => {
    const { REGISTRY } = await import("@/lib/privacy/registry");
    const category = REGISTRY.find((c) => c.key === "messages");
    expect(category?.tables).toEqual(["message_threads", "messages", "thread_reads"]);
    const mine = (await category!.export!({ sql, childId: w.childId, guardianUserId: w.guardianA.id }))?.data as {
      id: string; subject: string; org_name: string; last_read_at: string | null; messages: { body: string; own: boolean; sender_kind: string }[];
    }[];
    const sleep = mine.find((t) => t.subject === "t027 Sleep question");
    expect(sleep?.messages[0]).toMatchObject({ body: SECRET, own: true, sender_kind: "guardian" });
    expect(sleep?.org_name).toContain("Centre A");
    expect(mine.find((t) => t.subject === "t027 delete")?.messages.some((m) => m.body === DELETED_BODY)).toBe(true);
    // Another family (not linked) gets nothing, even with this child's id.
    expect((await category!.export!({ sql, childId: w.childId, guardianUserId: w.guardianB.id }))?.data).toEqual([]);

    const rollback = new Error("rollback");
    await expect(
      sql.begin(async (tx) => {
        const n = await category!.erase!.rows!(tx, { childId: w.childId, requestId: crypto.randomUUID(), scope: "everything", requestedBy: w.guardianA.id, caseIds: [w.caseA, w.caseB] });
        expect(n).toBe(mine.length);
        expect((await tx`select id from message_threads where child_id = ${w.childId}`).length).toBe(0);
        expect((await tx`select id from outbox_events where aggregate_type = 'thread' and aggregate_id in ${tx(mine.map((t) => t.id))}`).length).toBe(0);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  });

  it("E-5 / NFR-3: audit rows and logs never contain message text", async () => {
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from audit_events where case_id in ${sql([w.caseA, w.caseB, w.caseNoGuardian])}
        and (details::text like ${`%${SECRET}%`} or details::text like '%(synthetic)%')`;
    expect(n).toBe(0);
    const [{ sent }] = await sql<{ sent: number }[]>`
      select count(*)::int as sent from audit_events where case_id = ${w.caseA} and action = 'message.sent'`;
    expect(sent).toBeGreaterThan(5);
    expect(logged.filter((line) => line.includes(SECRET))).toEqual([]);
  });
});
