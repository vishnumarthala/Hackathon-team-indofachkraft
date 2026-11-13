// Ticket 041 FR-7 / FR-8 / NFR-1: guardian data export (only what the guardian can see, limits, requester-only download,
// notification) and deletion requests (review, idempotent and resumable execution, ElevenLabs deletion log with
// failure + retry, pseudonymisation, retained-but-redacted consent and audit). Local Supabase stack; synthetic data.
import { randomUUID } from "node:crypto";
import { loadEnvConfig } from "@next/env";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createUploader, PDF_BYTES, PNG_BYTES, purgeDocumentObjects } from "./helpers/documents";
import { createWorld, ctx, post, type TestUser } from "./helpers/world";

loadEnvConfig(process.cwd(), false, { info: () => {}, error: () => {} });
const enabled = Boolean(process.env.DATABASE_URL) && process.env.SKIP_DB_TESTS !== "1";

const session = vi.hoisted(() => ({ user: null as null | { id: string; email: string } }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getAuthenticatedUser: vi.fn(async () => session.user) };
});

type Db = ReturnType<typeof import("@/lib/db").supabaseAdmin>;

describe.skipIf(!enabled)("041 export and deletion (database)", { timeout: 120_000 }, () => {
  let sql: Sql;
  let db: Db;
  let world: ReturnType<typeof createWorld>;
  let providerA: TestUser, guardianA: TestUser, guardianB: TestUser, outsider: TestUser, admin: TestUser;
  let orgA: string;
  let kase: Awaited<ReturnType<ReturnType<typeof createWorld>["kase"]>>;
  let kase2: Awaited<ReturnType<ReturnType<typeof createWorld>["kase"]>>;
  const conv = (n: number) => `t041-conv-${n}-${randomUUID().slice(0, 8)}`;
  const convs: string[] = [];
  const docs: { guardian?: string; visible?: string; hidden?: string } = {};
  const exportIds: string[] = [];
  const as = (u: TestUser | null) => {
    session.user = u;
  };

  const routes = async () => ({
    exports: await import("@/app/api/family/children/[id]/exports/route"),
    download: await import("@/app/api/family/exports/[id]/download/route"),
    deletion: await import("@/app/api/family/children/[id]/deletion-requests/route"),
    review: await import("@/app/api/admin/privacy/requests/[id]/route"),
  });

  async function addAudio(caseId: string, recordingId: string) {
    const path = `${caseId}/${recordingId}.wav`;
    const { error } = await db.storage.from("recordings").upload(path, Buffer.from("RIFF0000WAVEsynthetic"), {
      contentType: "audio/wav",
      upsert: true,
    });
    if (error) throw new Error(`audio upload failed: ${error.message}`);
    return path;
  }

  async function objectExists(bucket: string, path: string) {
    const { data } = await db.storage.from(bucket).exists(path);
    return data === true;
  }

  async function outboxEvent(dedup: string) {
    const [row] = await sql<{ id: string }[]>`select id::text as id from outbox_events where dedup_key = ${dedup}`;
    return row?.id ?? null;
  }

  async function deliver(eventId: string) {
    const { runOutbox } = await import("@/lib/notify/worker");
    await runOutbox({ eventIds: [eventId], senders: { email: async () => ({ status: "sent", providerMessageId: "test" }), whatsapp: async () => ({ status: "skipped", reason: "whatsapp_not_configured" }) } });
  }

  beforeAll(async () => {
    sql = postgres(process.env.DATABASE_URL as string, { max: 4, prepare: false, onnotice: () => {} });
    db = (await import("@/lib/db")).supabaseAdmin();
    world = createWorld(sql, db, "t041x");
    providerA = await world.user("provider-a", "provider");
    guardianA = await world.user("guardian-a", "guardian", { phoneVerified: true });
    guardianB = await world.user("guardian-b", "guardian", { phoneVerified: true });
    outsider = await world.user("guardian-c", "guardian", { phoneVerified: true });
    admin = await world.user("admin", "platform_admin");
    orgA = await world.org(providerA, "Centre A");

    // Child 1 (export + "everything"): session audio, two intake conversations, facts, health, three documents.
    kase = await world.kase(orgA);
    const linkA = await world.link(kase.childId, guardianA);
    await world.link(kase.childId, guardianB, "father");
    await world.grant(kase.childId, guardianA, linkA);
    await addAudio(kase.caseId, kase.recordingId);
    for (const n of [1, 2]) {
      const id = conv(n);
      convs.push(id);
      await sql`insert into recordings (case_id, kind, status, external_id, segments) values (${kase.caseId}, 'intake_call', 'transcribed', ${id}, '[]'::jsonb)`;
    }
    await sql`
      insert into child_health_profiles (child_id, blood_group, allergies, updated_by)
      values (${kase.childId}, 'B+', ${sql.json([{ substance: "Peanut (synthetic)", reaction: "rash", severity: "severe" }])}, ${guardianA.id})`;
    const uploader = createUploader(db, as);
    docs.guardian = (await uploader.upload(guardianA, { childId: kase.childId }, { title: "t041 School letter", category: "school", file_name: "letter.pdf", mime_type: "application/pdf" }, PDF_BYTES)).id;
    docs.visible = (await uploader.upload(providerA, { caseId: kase.caseId }, { title: "t041 Visible note", category: "assessment", file_name: "visible.png", mime_type: "image/png", visible_to_guardian: true }, PNG_BYTES)).id;
    docs.hidden = (await uploader.upload(providerA, { caseId: kase.caseId }, { title: "t041 Provider-only note", category: "assessment", file_name: "hidden.png", mime_type: "image/png", visible_to_guardian: false }, PNG_BYTES)).id;

    // Child 2 ("all_ai_processing").
    kase2 = await world.kase(orgA);
    const link2 = await world.link(kase2.childId, guardianA);
    await world.grant(kase2.childId, guardianA, link2);
    await addAudio(kase2.caseId, kase2.recordingId);
    convs.push(conv(3));
    await sql`insert into recordings (case_id, kind, status, external_id) values (${kase2.caseId}, 'intake_call', 'transcribed', ${convs[2]})`;
    await sql`
      insert into facts (case_id, recording_id, instrument, item_id, value, source, status)
      values (${kase2.caseId}, ${kase2.recordingId}, 'ISAA', '1', '3'::jsonb, 'session', 'suggested'),
             (${kase2.caseId}, ${kase2.recordingId}, 'ISAA', '2', '2'::jsonb, 'session', 'confirmed')`;
    await sql`
      insert into reports (case_id, kind, content, content_md, status)
      values (${kase2.caseId}, 'parent_summary', '{}'::jsonb, '# draft (synthetic)', 'draft')`;
  });

  afterAll(async () => {
    as(null);
    if (sql) {
      const childIds = [kase?.childId, kase2?.childId].filter(Boolean) as string[];
      const paths = await sql<{ storage_path: string }[]>`select storage_path from privacy_exports where child_id in ${sql(childIds)} and storage_path is not null`;
      if (paths.length) await db.storage.from("exports").remove(paths.map((p) => p.storage_path));
      await purgeDocumentObjects(sql, db, childIds);
      for (const k of [kase, kase2]) if (k) await db.storage.from("recordings").remove([`${k.caseId}/${k.recordingId}.wav`]);
      await sql`delete from outbox_events where aggregate_type in ('privacy_export', 'deletion_request') and payload ->> 'child_id' in ${sql(childIds)}`;
      await sql`delete from outbox_events where topic = 'privacy.deletion_completed' and aggregate_id in (select id from deletion_requests where child_id in ${sql(childIds)})`;
      await sql`delete from deletion_requests where child_id in ${sql(childIds)}`;
      await sql`delete from privacy_exports where child_id in ${sql(childIds)}`;
    }
    await world?.cleanup();
    await sql?.end({ timeout: 5 });
  });

  beforeEach(() => as(null));

  describe("export (FR-7)", () => {
    it("202, one running per child (429), only guardian-visible content, notification, requester-only download", async () => {
      const r = await routes();
      as(guardianA);
      const first = await r.exports.POST(post("http://localhost/x", { actor: "platform_admin" }), ctx({ id: kase.childId }));
      expect(first.status).toBe(202);
      const { export_id } = (await first.json()) as { export_id: string };
      exportIds.push(export_id);
      const running = await r.exports.POST(post("http://localhost/x"), ctx({ id: kase.childId }));
      expect(running.status).toBe(429);

      const [audited] = await sql`select actor_user_id, actor_role from audit_events where action = 'privacy.export_requested' and entity_id = ${export_id}`;
      expect(audited).toEqual({ actor_user_id: guardianA.id, actor_role: "guardian" });

      const { runPrivacyJobs } = await import("@/lib/privacy/jobs");
      expect((await runPrivacyJobs({ exportIds: [export_id], deletionIds: [] })).exports).toEqual({ ready: 1 });
      // Re-running a finished export is a no-op (NFR-1).
      expect((await runPrivacyJobs({ exportIds: [export_id], deletionIds: [] })).exports).toEqual({ skipped: 1 });

      const [row] = await sql<{ storage_path: string; status: string }[]>`select storage_path, status from privacy_exports where id = ${export_id}`;
      expect(row.status).toBe("ready");
      const { data } = await db.storage.from("exports").download(row.storage_path);
      const { readZip } = await import("@/lib/privacy/zip");
      const files = await readZip(Buffer.from(await data!.arrayBuffer()));
      const child = JSON.parse(files.get("child.json")!.toString("utf8"));
      const s = child.sections;
      expect(s.child_profile.child.id).toBe(kase.childId);
      expect(s.consent_records.length).toBeGreaterThanOrEqual(8);
      expect(s.consent_records[0]).toMatchObject({ action: "granted", by_you: true });
      expect(s.health_profile.current.allergies[0].substance).toBe("Peanut (synthetic)");
      const titles = s.documents.map((d: { title: string }) => d.title).sort();
      expect(titles).toEqual(["t041 School letter", "t041 Visible note"]);
      const docFiles = [...files.keys()].filter((k) => k.startsWith("documents/"));
      expect(docFiles).toHaveLength(2);
      expect(docFiles.some((k) => k.includes(docs.hidden!))).toBe(false);
      for (const buf of files.values()) expect(buf.toString("latin1")).not.toContain("Provider-only");
      // Clinical case data the guardian cannot see in the portal is not exported.
      expect(JSON.stringify(child)).not.toContain("He lines up toys");

      // Notification to the requester (in-app; email through the stubbed sender).
      const eventId = await outboxEvent(`privacy.export_ready:${export_id}`);
      expect(eventId).not.toBeNull();
      await deliver(eventId!);
      const notes = await sql`select recipient_user_id, channel, template, link from notifications where event_id = ${eventId}`;
      expect(notes.filter((n) => n.channel === "in_app")).toEqual([
        { recipient_user_id: guardianA.id, channel: "in_app", template: "privacy_export_ready", link: `/family/children/${kase.childId}/privacy` },
      ]);

      // Download: requester -> 302 to a signed URL; another guardian of the same child, other families, providers -> 404/403.
      const dl = await r.download.GET(new Request("http://localhost/x"), ctx({ id: export_id }));
      expect(dl.status).toBe(302);
      expect(dl.headers.get("location")).toContain("/storage/v1/object/sign/exports/");
      as(guardianB);
      expect((await r.download.GET(new Request("http://localhost/x"), ctx({ id: export_id }))).status).toBe(404);
      as(outsider);
      expect((await r.download.GET(new Request("http://localhost/x"), ctx({ id: export_id }))).status).toBe(404);
      expect((await r.exports.POST(post("http://localhost/x"), ctx({ id: kase.childId }))).status).toBe(404);
      as(providerA);
      expect((await r.download.GET(new Request("http://localhost/x"), ctx({ id: export_id }))).status).toBe(403);
      const downloads = await sql`select actor_user_id from audit_events where action = 'privacy.export_downloaded' and entity_id = ${export_id}`;
      expect(downloads).toEqual([{ actor_user_id: guardianA.id }]);
    });

    it("3 per child per day, the 4th -> 429", async () => {
      const r = await routes();
      const { runPrivacyJobs } = await import("@/lib/privacy/jobs");
      as(guardianA);
      for (let i = 0; i < 2; i++) {
        const res = await r.exports.POST(post("http://localhost/x"), ctx({ id: kase.childId }));
        expect(res.status).toBe(202);
        const id = ((await res.json()) as { export_id: string }).export_id;
        exportIds.push(id);
        await runPrivacyJobs({ exportIds: [id], deletionIds: [] });
      }
      const fourth = await r.exports.POST(post("http://localhost/x"), ctx({ id: kase.childId }));
      expect(fourth.status).toBe(429);
      expect(await fourth.json()).toEqual({ error: "You can request 3 downloads per day. Please try again tomorrow." });
      const list = (await (await r.exports.GET(new Request("http://localhost/x"), ctx({ id: kase.childId }))).json()) as { exports: { status: string }[] };
      expect(list.exports.map((e) => e.status)).toEqual(["ready", "ready", "ready"]);
    });
  });

  describe("deletion requests (FR-8)", () => {
    let requestId: string;

    it("guardian requests (201, actor from the session), duplicate 409, provider 403, admin review rules", async () => {
      const r = await routes();
      as(providerA);
      expect((await r.deletion.POST(post("http://localhost/x", { scope: "everything" }), ctx({ id: kase.childId }))).status).toBe(403);
      as(guardianA);
      expect((await r.deletion.POST(post("http://localhost/x", { scope: "nothing" }), ctx({ id: kase.childId }))).status).toBe(400);
      const created = await r.deletion.POST(
        post("http://localhost/x", { scope: "everything", reason: "t041 synthetic", actor: "platform_admin", actor_user_id: admin.id, actor_role: "platform_admin" }),
        ctx({ id: kase.childId }),
      );
      expect(created.status).toBe(201);
      requestId = ((await created.json()) as { request: { id: string; status: string } }).request.id;
      const [audit] = await sql`select actor, actor_user_id, actor_role, child_id from audit_events where action = 'privacy.deletion_requested' and entity_id = ${requestId}`;
      expect(audit).toEqual({ actor: "guardian", actor_user_id: guardianA.id, actor_role: "guardian", child_id: kase.childId });
      expect((await r.deletion.POST(post("http://localhost/x", { scope: "all_ai_processing" }), ctx({ id: kase.childId }))).status).toBe(409);
      expect(await outboxEvent(`privacy.deletion_requested:${requestId}`)).not.toBeNull();

      as(providerA);
      expect((await r.review.POST(post("http://localhost/x", { decision: "approve" }), ctx({ id: requestId }))).status).toBe(403);
      as(guardianA);
      expect((await r.review.POST(post("http://localhost/x", { decision: "approve" }), ctx({ id: requestId }))).status).toBe(403);
      as(admin);
      expect((await r.review.POST(post("http://localhost/x", { decision: "reject", note: "no" }), ctx({ id: requestId }))).status).toBe(400);
      expect((await r.review.POST(post("http://localhost/x", { decision: "approve" }), ctx({ id: randomUUID() }))).status).toBe(404);
      const approved = await r.review.POST(post("http://localhost/x", { decision: "approve" }), ctx({ id: requestId }));
      expect(approved.status).toBe(200);
      expect(await approved.json()).toEqual({ id: requestId, status: "approved" });
      expect((await r.review.POST(post("http://localhost/x", { decision: "approve" }), ctx({ id: requestId }))).status).toBe(409);
      const [reviewed] = await sql`select actor_user_id, actor_role, details from audit_events where action = 'privacy.deletion_reviewed' and entity_id = ${requestId}`;
      expect(reviewed).toMatchObject({ actor_user_id: admin.id, actor_role: "platform_admin", details: { decision: "approved" } });
    });

    it("execution: processor failure recorded and retried, each conversation deleted once, child erased, audit kept; re-run no-op", async () => {
      const { executeDeletion } = await import("@/lib/privacy/deletion");
      const auditBefore = (await sql<{ n: number }[]>`select count(*)::int as n from audit_events where child_id = ${kase.childId}`)[0].n;
      const paths = {
        audio: `${kase.caseId}/${kase.recordingId}.wav`,
        docs: (await sql<{ storage_path: string }[]>`select storage_path from documents where child_id = ${kase.childId}`).map((d) => d.storage_path),
        exports: (await sql<{ storage_path: string }[]>`select storage_path from privacy_exports where child_id = ${kase.childId}`).map((d) => d.storage_path),
      };
      expect(paths.docs).toHaveLength(3);

      let failNext = true;
      const deleter = vi.fn(async (id: string) => {
        if (id === convs[1] && failNext) {
          failNext = false;
          return { status: "failed" as const, responseCode: 503 };
        }
        return { status: "deleted" as const, responseCode: 200 };
      });

      expect(await executeDeletion(requestId, { deleteConversation: deleter })).toBe("failed");
      const log1 = await sql`select processor, external_ref, status, response_code, attempts from processor_deletions where request_id = ${requestId} order by processor, external_ref`;
      expect(log1).toEqual(
        expect.arrayContaining([
          { processor: "elevenlabs", external_ref: convs[0], status: "deleted", response_code: 200, attempts: 1 },
          { processor: "elevenlabs", external_ref: convs[1], status: "failed", response_code: 503, attempts: 1 },
          { processor: "gemini", external_ref: "no-deletion-api", status: "not_applicable", response_code: null, attempts: 0 },
        ]),
      );
      // The local erasure did not wait for the processor.
      const [child] = await sql`select display_name, date_of_birth, sex, deleted_at is not null as deleted from children where id = ${kase.childId}`;
      expect(child).toEqual({ display_name: "Deleted child", date_of_birth: null, sex: null, deleted: true });

      expect(await executeDeletion(requestId, { deleteConversation: deleter })).toBe("completed");
      expect(deleter.mock.calls.filter(([id]) => id === convs[0])).toHaveLength(1);
      expect(deleter.mock.calls.filter(([id]) => id === convs[1])).toHaveLength(2);
      const [done] = await sql`select status, completed_at is not null as completed from deletion_requests where id = ${requestId}`;
      expect(done).toEqual({ status: "completed", completed: true });

      // Rows and objects are gone everywhere.
      expect((await sql`select 1 from cases where child_id = ${kase.childId}`).length).toBe(0);
      expect((await sql`select 1 from documents where child_id = ${kase.childId}`).length).toBe(0);
      expect((await sql`select 1 from child_health_profiles where child_id = ${kase.childId}`).length).toBe(0);
      expect((await sql`select 1 from child_health_profile_history where child_id = ${kase.childId}`).length).toBe(0);
      expect((await sql`select 1 from privacy_exports where child_id = ${kase.childId}`).length).toBe(0);
      expect(await objectExists("recordings", paths.audio)).toBe(false);
      for (const p of paths.docs) expect(await objectExists("documents", p)).toBe(false);
      for (const p of paths.exports) expect(await objectExists("exports", p)).toBe(false);
      expect((await sql`select 1 from guardian_links where child_id = ${kase.childId} and status = 'active'`).length).toBe(0);

      // Consent: withdrawals appended (log kept), free text stripped.
      const state = await sql`select feature, action from child_consent_state where child_id = ${kase.childId}`;
      expect(state).toHaveLength(8);
      expect(state.every((s) => s.action === "withdrawn")).toBe(true);
      expect((await sql`select 1 from consent_records where child_id = ${kase.childId} and action = 'granted'`).length).toBe(8);
      expect((await sql`select 1 from consent_records where child_id = ${kase.childId} and user_agent is not null`).length).toBe(0);

      // Audit rows retained (more than before: request/review/execution), stripped of free text.
      const auditAfter = await sql<{ details: Record<string, unknown>; action: string }[]>`
        select action, details from audit_events where child_id = ${kase.childId}`;
      expect(auditAfter.length).toBeGreaterThan(auditBefore);
      expect(auditAfter.filter((a) => a.action === "document.uploaded").every((a) => a.details.redacted === true)).toBe(true);
      expect(JSON.stringify(auditAfter)).not.toContain("t041 synthetic");

      // Guardian notified.
      const eventId = await outboxEvent(`privacy.deletion_completed:${requestId}`);
      expect(eventId).not.toBeNull();
      await deliver(eventId!);
      const notes = await sql`select recipient_user_id from notifications where event_id = ${eventId} and channel = 'in_app'`;
      expect(notes).toEqual([{ recipient_user_id: guardianA.id }]);

      // E-4 step 2: the provider sees nothing (404); the guardians lose the child (404).
      as(providerA);
      const { requireCaseAccess } = await import("@/lib/authz");
      expect((await requireCaseAccess(kase.caseId))?.status).toBe(404);
      as(guardianA);
      const r = await routes();
      expect((await r.exports.POST(post("http://localhost/x"), ctx({ id: kase.childId }))).status).toBe(404);

      // NFR-1: a completed request is never executed again.
      deleter.mockClear();
      expect(await executeDeletion(requestId, { deleteConversation: deleter })).toBeNull();
      expect(deleter).not.toHaveBeenCalled();
    });

    it("all_ai_processing: AI data and audio go, clinician-confirmed records and the child stay; rejection cites the obligation", async () => {
      const { createDeletionRequest, executeDeletion, reviewDeletionRequest } = await import("@/lib/privacy/deletion");
      const { auditActorOf } = await import("@/lib/audit");
      const created = await createDeletionRequest(
        { childId: kase2.childId, guardianUserId: guardianA.id, scope: "all_ai_processing" },
        auditActorOf(guardianA, "guardian"),
      );
      expect(created.ok).toBe(true);
      const id = created.ok ? created.request.id : "";
      expect((await reviewDeletionRequest(id, "approve", null, auditActorOf(admin, "platform_admin"))).ok).toBe(true);
      const deleter = vi.fn(async () => ({ status: "deleted" as const, responseCode: 200 }));
      expect(await executeDeletion(id, { deleteConversation: deleter })).toBe("completed");
      expect(deleter).toHaveBeenCalledTimes(1);
      expect(deleter).toHaveBeenCalledWith(convs[2]);

      const [rec] = await sql`select storage_path, segments, audio_deleted_at is not null as audio_deleted from recordings where id = ${kase2.recordingId}`;
      expect(rec).toEqual({ storage_path: null, segments: [], audio_deleted: true });
      expect(await objectExists("recordings", `${kase2.caseId}/${kase2.recordingId}.wav`)).toBe(false);
      expect((await sql`select status from facts where case_id = ${kase2.caseId}`).map((f) => f.status)).toEqual(["confirmed"]);
      expect((await sql`select status from reports where case_id = ${kase2.caseId} order by status`).map((x) => x.status)).toEqual(["final"]);
      const [child] = await sql`select display_name, deleted_at from children where id = ${kase2.childId}`;
      expect(child.deleted_at).toBeNull();
      expect(child.display_name).not.toBe("Deleted child");
      const state = Object.fromEntries((await sql`select feature, granted from child_consent_state where child_id = ${kase2.childId}`).map((s) => [s.feature, s.granted]));
      expect(state).toMatchObject({ ai_intake_call: false, session_recording: false, ai_transcription: false, ai_extraction: false, referral_share: true, screen_result_save: true });

      // A new request can be rejected, citing the record-keeping obligation; the guardian sees the reason.
      const again = await createDeletionRequest({ childId: kase2.childId, guardianUserId: guardianA.id, scope: "everything" }, auditActorOf(guardianA, "guardian"));
      const id2 = again.ok ? again.request.id : "";
      const note = "Clinical records must be kept for 3 years (state clinical establishment rules).";
      expect((await reviewDeletionRequest(id2, "reject", note, auditActorOf(admin, "platform_admin"))).ok).toBe(true);
      expect(await outboxEvent(`privacy.deletion_rejected:${id2}`)).not.toBeNull();
      as(guardianA);
      const r = await routes();
      const list = (await (await r.deletion.GET(new Request("http://localhost/x"), ctx({ id: kase2.childId }))).json()) as {
        requests: { id: string; status: string; review_note: string | null }[];
      };
      expect(list.requests.find((x) => x.id === id2)).toMatchObject({ status: "rejected", review_note: note });
      expect(await executeDeletion(id2)).toBeNull();
    });
  });
});
