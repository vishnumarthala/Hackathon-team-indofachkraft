// Ticket 041 FR-6 / FR-9 / FR-12: retention job (audio 90 days after transcription with the transcript kept, unfinished
// uploads, orphaned objects, expired exports, notifications, sign-ups, audit after 7 years, audio of withdrawn consent),
// one `retention.run` audit row per run, second run is a no-op; cron auth; health check. Local Supabase; synthetic data.
import { randomUUID } from "node:crypto";
import { loadEnvConfig } from "@next/env";
import postgres, { type Sql } from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { purgeTestAudit } from "./helpers/audit";
import { createWorld, type TestUser } from "./helpers/world";

loadEnvConfig(process.cwd(), false, { info: () => {}, error: () => {} });
const enabled = Boolean(process.env.DATABASE_URL) && process.env.SKIP_DB_TESTS !== "1";

describe("retention policy (FR-6)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("defaults match FR-6 and the 023 hand-off; RETENTION_AUDIO_DAYS overrides; invalid values fall back", async () => {
    const { retentionPolicy } = await import("@/lib/privacy/retention");
    vi.stubEnv("RETENTION_AUDIO_DAYS", "");
    expect(retentionPolicy()).toEqual({
      audioDays: 90,
      pendingRecordingHours: 24,
      pendingDocumentHours: 1,
      orphanObjectHours: 24,
      inAppNotificationDays: 180,
      deliveryContentDays: 90,
      pilotSignupMonths: 24,
      auditYears: 7,
      exportDays: 7,
    });
    vi.stubEnv("RETENTION_AUDIO_DAYS", "30");
    expect(retentionPolicy().audioDays).toBe(30);
    vi.stubEnv("RETENTION_AUDIO_DAYS", "-4");
    expect(retentionPolicy().audioDays).toBe(90);
  });
});

describe("health check (FR-12)", () => {
  afterEach(() => {
    vi.doUnmock("@/lib/privacy/ops");
    vi.resetModules();
  });

  it("checkDatabase is false when the query fails or hangs", async () => {
    const { checkDatabase } = await import("@/lib/privacy/ops");
    const failing = (() => Promise.reject(new Error("connection refused"))) as unknown as Parameters<typeof checkDatabase>[0];
    expect(await checkDatabase(failing)).toBe(false);
    const hanging = (() => new Promise(() => {})) as unknown as Parameters<typeof checkDatabase>[0];
    expect(await checkDatabase(hanging, 50)).toBe(false);
  });

  it("GET /api/health -> 503 { ok: false, db: 'unreachable' } without the database; never any secret", async () => {
    vi.resetModules();
    vi.doMock("@/lib/privacy/ops", () => ({ checkDatabase: async () => false }));
    const { GET } = await import("@/app/api/health/route");
    const res = await GET();
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: false, db: "unreachable" });
    expect(Object.keys(body).sort()).toEqual(["db", "ok", "version"]);
  });

  it.skipIf(!enabled)("GET /api/health -> 200 { ok: true, db: 'ok', version } with the database", async () => {
    const { GET } = await import("@/app/api/health/route");
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, db: "ok", version: expect.any(String) });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe.skipIf(!enabled)("retention job (database)", { timeout: 120_000 }, () => {
  let sql: Sql;
  let db: ReturnType<typeof import("@/lib/db").supabaseAdmin>;
  let world: ReturnType<typeof createWorld>;
  let provider: TestUser, guardian: TestUser;
  const objects: { bucket: string; path: string }[] = [];
  const ids: Record<string, string> = {};
  const auditIds: string[] = [];
  const signup = `t041-signup-${randomUUID().slice(0, 8)}@example.test`;
  let pingEvent: string;

  async function put(bucket: string, path: string, contentType: string, ageHours = 0) {
    const { error } = await db.storage.from(bucket).upload(path, Buffer.from("%PDF-1.4 synthetic"), { contentType, upsert: true });
    if (error) throw new Error(`upload ${bucket}/${path}: ${error.message}`);
    if (ageHours) await sql`update storage.objects set created_at = now() - ${`${ageHours} hours`}::interval where bucket_id = ${bucket} and name = ${path}`;
    objects.push({ bucket, path });
    return path;
  }

  async function exists(bucket: string, path: string) {
    const { data } = await db.storage.from(bucket).exists(path);
    return data === true;
  }

  async function sessionRecording(caseId: string, opts: { status: string; transcribedDaysAgo?: number; createdHoursAgo?: number }) {
    const id = randomUUID();
    const path = await put("recordings", `${caseId}/${id}.wav`, "audio/wav");
    await sql`
      insert into recordings (id, case_id, kind, session_number, status, storage_path, mime_type, segments)
      values (${id}, ${caseId}, 'session', 2, ${opts.status}, ${path}, 'audio/wav',
              ${sql.json([{ id: "s1", speaker: "parent", speaker_label: "speaker_1", start_sec: 0, end_sec: 3, text: "Synthetic transcript." }])})`;
    if (opts.transcribedDaysAgo !== undefined) {
      await sql`update recordings set transcribed_at = now() - ${`${opts.transcribedDaysAgo} days`}::interval where id = ${id}`;
    }
    if (opts.createdHoursAgo !== undefined) {
      await sql`update recordings set created_at = now() - ${`${opts.createdHoursAgo} hours`}::interval where id = ${id}`;
    }
    return { id, path };
  }

  beforeAll(async () => {
    sql = postgres(process.env.DATABASE_URL as string, { max: 4, prepare: false, onnotice: () => {} });
    db = (await import("@/lib/db")).supabaseAdmin();
    world = createWorld(sql, db, "t041r");
    provider = await world.user("provider", "provider");
    guardian = await world.user("guardian", "guardian", { phoneVerified: true });
    const org = await world.org(provider, "Centre R");

    const a = await world.kase(org);
    const old = await sessionRecording(a.caseId, { status: "extracted", transcribedDaysAgo: 91 });
    const recent = await sessionRecording(a.caseId, { status: "transcribed", transcribedDaysAgo: 10 });
    const pending = await sessionRecording(a.caseId, { status: "created", createdHoursAgo: 25 });
    Object.assign(ids, { old: old.id, oldPath: old.path, recent: recent.id, recentPath: recent.path, pending: pending.id, pendingPath: pending.path });

    // FR-9: consent withdrawn -> unprocessed audio deleted; another child with consent keeps it.
    const w = await world.kase(org);
    const wLink = await world.link(w.childId, guardian);
    await world.grant(w.childId, guardian, wLink, ["session_recording"]);
    await world.withdraw(w.childId, guardian, wLink, ["session_recording"]);
    const withdrawn = await sessionRecording(w.caseId, { status: "created", createdHoursAgo: 2 });
    const g = await world.kase(org);
    const gLink = await world.link(g.childId, guardian);
    await world.grant(g.childId, guardian, gLink, ["session_recording"]);
    const granted = await sessionRecording(g.caseId, { status: "created", createdHoursAgo: 2 });
    Object.assign(ids, { withdrawn: withdrawn.id, withdrawnPath: withdrawn.path, granted: granted.id, grantedPath: granted.path });

    // 023 hand-off: a pending document upload (2 h) and an orphaned object (no row, 25 h).
    const docId = randomUUID();
    const docPath = await put("documents", `${a.childId}/${docId}.pdf`, "application/pdf");
    await sql`
      insert into documents (id, child_id, uploaded_by, uploader_kind, category, title, file_name, mime_type, size_bytes, storage_path, created_at)
      values (${docId}, ${a.childId}, ${guardian.id}, 'guardian', 'other', 't041 pending (synthetic)', 'p.pdf', 'application/pdf', 18,
              ${docPath}, now() - interval '2 hours')`;
    const orphan = await put("documents", `${a.childId}/${randomUUID()}.pdf`, "application/pdf", 25);
    const freshOrphan = await put("documents", `${a.childId}/${randomUUID()}.pdf`, "application/pdf", 1);
    Object.assign(ids, { doc: docId, docPath, orphan, freshOrphan });

    // Expired export.
    const exportId = randomUUID();
    const exportPath = await put("exports", `${a.childId}/${exportId}.zip`, "application/zip");
    await sql`
      insert into privacy_exports (id, child_id, requested_by, status, storage_path, completed_at, expires_at)
      values (${exportId}, ${a.childId}, ${guardian.id}, 'ready', ${exportPath}, now() - interval '8 days', now() - interval '1 day')`;
    Object.assign(ids, { exportId, exportPath });

    // Notifications: in-app 181 days old, email 91 days old with text, email 10 days old.
    const [ev] = await sql<{ id: string }[]>`
      select public.outbox_enqueue('test.ping', 'user', ${guardian.id}::uuid, '{}'::jsonb, ${`t041r:${randomUUID()}`}, now())::text as id`;
    pingEvent = ev.id;
    await sql`update outbox_events set status = 'cancelled' where id = ${pingEvent}`;
    const [inApp] = await sql<{ id: string }[]>`
      insert into notifications (event_id, recipient_user_id, channel, template, status, title, body, link, created_at)
      values (${pingEvent}, ${guardian.id}, 'in_app', 'test_ping', 'sent', 'Old', 'Old body', '/family', now() - interval '181 days') returning id`;
    const [email] = await sql<{ id: string }[]>`
      insert into notifications (event_id, recipient_user_id, channel, template, status, title, body, link, created_at)
      values (${pingEvent}, ${guardian.id}, 'email', 'test_ping', 'sent', 'Old title', 'Old body', '/family', now() - interval '91 days') returning id`;
    const [newer] = await sql<{ id: string }[]>`
      insert into notifications (event_id, recipient_user_id, channel, template, status, title, body, link, created_at)
      values (${pingEvent}, ${guardian.id}, 'whatsapp', 'test_ping', 'sent', 'New title', 'New body', '/family', now() - interval '10 days') returning id`;
    Object.assign(ids, { inApp: inApp.id, email: email.id, newer: newer.id });

    await sql`
      insert into pilot_signups (name, email, role, country, created_at)
      values ('t041 Synthetic', ${signup}, 'parent', 'India', now() - interval '25 months')`;

    const [ancient] = await sql<{ id: string }[]>`
      insert into audit_events (actor, action, created_at) values ('system', 't041.ancient', now() - interval '8 years') returning id::text as id`;
    const [kept] = await sql<{ id: string }[]>`
      insert into audit_events (actor, action, created_at) values ('system', 't041.six_years', now() - interval '6 years') returning id::text as id`;
    auditIds.push(ancient.id, kept.id);
  });

  afterAll(async () => {
    if (sql) {
      for (const o of objects) await db.storage.from(o.bucket).remove([o.path]);
      if (ids.exportId) await sql`delete from privacy_exports where id = ${ids.exportId}`;
      if (pingEvent) await sql`delete from outbox_events where id = ${pingEvent}`;
      await sql`delete from pilot_signups where email = ${signup}`;
      await purgeTestAudit(sql, (tx) => tx`delete from audit_events where id in ${tx(auditIds)}`);
    }
    await world?.cleanup();
    await sql?.end({ timeout: 5 });
  });

  it("deletes what is due (objects first), keeps transcripts and everything not due, audits counts; second run is a no-op", async () => {
    const { runRetention } = await import("@/lib/privacy/retention");
    const counts = await runRetention();
    for (const key of [
      "audio_after_transcription",
      "withdrawn_consent_audio",
      "pending_recordings",
      "pending_documents",
      "orphan_document_objects",
      "expired_exports",
      "in_app_notifications",
      "delivery_content",
      "pilot_signups",
      "audit_events",
    ]) {
      expect(counts[key], key).toBeGreaterThanOrEqual(1);
    }

    // Audio 90 days after transcription: object and path gone, transcript kept.
    const [old] = await sql`select storage_path, audio_deleted_at is not null as deleted, segments from recordings where id = ${ids.old}`;
    expect(old).toMatchObject({ storage_path: null, deleted: true });
    expect(old.segments[0].text).toBe("Synthetic transcript.");
    expect(await exists("recordings", ids.oldPath)).toBe(false);
    expect((await sql`select storage_path from recordings where id = ${ids.recent}`)[0].storage_path).toBe(ids.recentPath);
    expect(await exists("recordings", ids.recentPath)).toBe(true);

    // Unfinished session upload (25 h): row and object gone.
    expect(await sql`select 1 from recordings where id = ${ids.pending}`).toHaveLength(0);
    expect(await exists("recordings", ids.pendingPath)).toBe(false);

    // FR-9: withdrawn consent -> audio gone (row kept, nothing processed); granted -> kept.
    const [w] = await sql`select storage_path, status from recordings where id = ${ids.withdrawn}`;
    expect(w).toEqual({ storage_path: null, status: "created" });
    expect(await exists("recordings", ids.withdrawnPath)).toBe(false);
    expect((await sql`select storage_path from recordings where id = ${ids.granted}`)[0].storage_path).toBe(ids.grantedPath);
    expect(await exists("recordings", ids.grantedPath)).toBe(true);

    // Documents: pending row + object gone; orphan (25 h) gone; fresh orphan (1 h, upload token still valid) kept.
    expect(await sql`select 1 from documents where id = ${ids.doc}`).toHaveLength(0);
    expect(await exists("documents", ids.docPath)).toBe(false);
    expect(await exists("documents", ids.orphan)).toBe(false);
    expect(await exists("documents", ids.freshOrphan)).toBe(true);

    // Export expired.
    expect((await sql`select status, storage_path from privacy_exports where id = ${ids.exportId}`)[0]).toEqual({ status: "expired", storage_path: null });
    expect(await exists("exports", ids.exportPath)).toBe(false);

    // Notifications.
    expect(await sql`select 1 from notifications where id = ${ids.inApp}`).toHaveLength(0);
    expect((await sql`select title, body from notifications where id = ${ids.email}`)[0]).toEqual({ title: null, body: null });
    expect((await sql`select title from notifications where id = ${ids.newer}`)[0].title).toBe("New title");

    // Sign-ups and audit.
    expect(await sql`select 1 from pilot_signups where email = ${signup}`).toHaveLength(0);
    expect(await sql`select 1 from audit_events where id = ${auditIds[0]}`).toHaveLength(0);
    expect(await sql`select 1 from audit_events where id = ${auditIds[1]}`).toHaveLength(1);

    // One retention.run audit row with the counts.
    const [run] = await sql`select actor_role, details from audit_events where action = 'retention.run' order by id desc limit 1`;
    expect(run.actor_role).toBe("system");
    expect(run.details.counts).toEqual(counts);

    // Second run: nothing left to do.
    const again = await runRetention();
    expect(Object.entries(again).filter(([, n]) => n !== 0)).toEqual([]);
  });

  it("cron route: 401 without the bearer secret, 200 with it", async () => {
    vi.stubEnv("CRON_SECRET", "t041-secret");
    const { POST, GET } = await import("@/app/api/cron/retention/route");
    expect((await POST(new Request("http://localhost/api/cron/retention", { method: "POST" }))).status).toBe(401);
    expect((await GET(new Request("http://localhost/x", { headers: { authorization: "Bearer wrong" } }))).status).toBe(401);
    const ok = await GET(new Request("http://localhost/x", { headers: { authorization: "Bearer t041-secret" } }));
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { counts: Record<string, number> }).counts).toHaveProperty("audio_after_transcription");
    const privacy = await import("@/app/api/cron/privacy/route");
    expect((await privacy.POST(new Request("http://localhost/x", { method: "POST" }))).status).toBe(401);
    vi.unstubAllEnvs();
  });

  it("FR-12: ops overview reports stuck recordings, failed processor deletions and the last retention run", async () => {
    const [extra] = await sql<{ id: string }[]>`select id from recordings where id = ${ids.recent}`;
    await sql`update recordings set status = 'transcribing', status_changed_at = now() - interval '45 minutes' where id = ${extra.id}`;
    const { opsOverview } = await import("@/lib/privacy/ops");
    const o = await opsOverview();
    expect(o.stuckRecordings.find((r) => r.id === extra.id)).toMatchObject({ status: "transcribing" });
    expect(o.retention.lastRunAt).not.toBeNull();
    expect(o.retention.counts).toHaveProperty("audio_after_transcription");
    expect(typeof o.outbox.pendingEvents).toBe("number");
    await sql`update recordings set status = 'transcribed' where id = ${extra.id}`;
  });
});
