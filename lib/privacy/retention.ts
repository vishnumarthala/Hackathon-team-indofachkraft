// 041 FR-6 / FR-9: scheduled retention. `POST /api/cron/retention` (daily, CRON_SECRET) runs `runRetention()`: each
// step is idempotent (a second run finds nothing to do) and storage objects are removed before their rows. One
// `retention.run` audit row per run carries the counts per step. Periods are overridable by env (documented in
// .env.example, the privacy notice and docs/privacy/retention.md).
import { auditStrict } from "@/lib/audit";
import { supabaseAdmin } from "@/lib/db";
import { logger } from "@/lib/log";
import { pg, type Queryable, type Sql } from "@/lib/pg";
import { UNSAVED_RETENTION_DAYS } from "@/lib/screen/questions";

const log = logger("retention");

function envNumber(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

export type RetentionPolicy = {
  audioDays: number;
  pendingRecordingHours: number;
  pendingDocumentHours: number;
  orphanObjectHours: number;
  inAppNotificationDays: number;
  deliveryContentDays: number;
  pilotSignupMonths: number;
  auditYears: number;
  exportDays: number;
};

export const RETENTION_DEFAULTS: RetentionPolicy = {
  audioDays: 90,
  pendingRecordingHours: 24,
  // 023 hand-off: unfinished document uploads go after 1 h (FR-6's 24 h is the upper bound).
  pendingDocumentHours: 1,
  // A signed upload token stays valid for 2 h, so an object can appear after its row was removed.
  orphanObjectHours: 24,
  inAppNotificationDays: 180,
  deliveryContentDays: 90,
  pilotSignupMonths: 24,
  auditYears: 7,
  exportDays: 7,
};

export function retentionPolicy(): RetentionPolicy {
  const d = RETENTION_DEFAULTS;
  return {
    audioDays: envNumber("RETENTION_AUDIO_DAYS", d.audioDays, 1),
    pendingRecordingHours: envNumber("RETENTION_PENDING_UPLOAD_HOURS", d.pendingRecordingHours, 1),
    pendingDocumentHours: envNumber("RETENTION_PENDING_DOCUMENT_HOURS", d.pendingDocumentHours, 1),
    orphanObjectHours: envNumber("RETENTION_ORPHAN_OBJECT_HOURS", d.orphanObjectHours, 3),
    inAppNotificationDays: envNumber("RETENTION_IN_APP_NOTIFICATION_DAYS", d.inAppNotificationDays, 1),
    deliveryContentDays: envNumber("RETENTION_DELIVERY_CONTENT_DAYS", d.deliveryContentDays, 1),
    pilotSignupMonths: envNumber("RETENTION_PILOT_SIGNUP_MONTHS", d.pilotSignupMonths, 1),
    auditYears: envNumber("RETENTION_AUDIT_YEARS", d.auditYears, 1),
    exportDays: envNumber("RETENTION_EXPORT_DAYS", d.exportDays, 1),
  };
}

export type ObjectRemover = (bucket: string, paths: string[]) => Promise<void>;

/** Removes storage objects in batches. Missing objects are not an error (idempotent). */
export const removeObjects: ObjectRemover = async (bucket, paths) => {
  for (let i = 0; i < paths.length; i += 100) {
    const batch = paths.slice(i, i + 100);
    const { error } = await supabaseAdmin().storage.from(bucket).remove(batch);
    if (error) throw new Error(`Could not remove ${batch.length} objects from ${bucket}: ${error.message}`);
  }
};

export type RetentionCounts = Record<string, number>;
export type RetentionOptions = { sql?: Sql; now?: Date; policy?: RetentionPolicy; remove?: ObjectRemover };

const hours = (n: number) => `${n} hours`;
const days = (n: number) => `${n} days`;

/** 033 FR-5: deletes public check-ins never saved to a child, 30 days after they started. Returns the count. */
export async function purgeUnsavedScreenSessions(sql: Queryable, now: Date): Promise<number> {
  const done = await sql`
    delete from public.screen_sessions
    where saved_child_id is null and created_at < ${now}::timestamptz - ${days(UNSAVED_RETENTION_DAYS)}::interval`;
  return done.count;
}

export async function runRetention(opts: RetentionOptions = {}): Promise<RetentionCounts> {
  const sql = opts.sql ?? (await pg());
  const now = opts.now ?? new Date();
  const p = opts.policy ?? retentionPolicy();
  const remove = opts.remove ?? removeObjects;
  const counts: RetentionCounts = {};

  // FR-6: raw audio 90 days after successful transcription (transcript, facts and reports stay).
  {
    const due = await sql<{ id: string; storage_path: string }[]>`
      select id, storage_path from public.recordings
      where storage_path is not null and audio_deleted_at is null and transcribed_at is not null
        and status in ('transcribed', 'extracted', 'failed')
        and transcribed_at < ${now}::timestamptz - ${days(p.audioDays)}::interval
      limit 1000`;
    if (due.length) await remove("recordings", due.map((r) => r.storage_path));
    const done = due.length
      ? await sql`update public.recordings set storage_path = null, audio_deleted_at = ${now} where id in ${sql(due.map((r) => r.id))}`
      : { count: 0 };
    counts.audio_after_transcription = done.count;
  }

  // FR-9: audio not yet processed for children whose session_recording / ai_intake_call consent was withdrawn
  // (a consent record exists for the feature but it is no longer granted). Uploads younger than an hour are left to
  // the request that is handling them (the queued-work re-check of 020 already blocks processing).
  {
    const due = await sql<{ id: string; storage_path: string }[]>`
      select r.id, r.storage_path from public.recordings r
      join public.cases c on c.id = r.case_id
      cross join lateral (select case r.kind when 'intake_call' then 'ai_intake_call' else 'session_recording' end as feature) f
      where r.storage_path is not null and r.audio_deleted_at is null and r.status in ('created', 'failed')
        and r.transcribed_at is null and r.created_at < ${now}::timestamptz - interval '1 hour'
        and exists (select 1 from public.consent_records cr where cr.child_id = c.child_id and cr.feature = f.feature)
        and not exists (
          select 1 from public.child_consent_state s where s.child_id = c.child_id and s.granted and s.feature = f.feature)
      limit 1000`;
    if (due.length) await remove("recordings", due.map((r) => r.storage_path));
    const done = due.length
      ? await sql`update public.recordings set storage_path = null, audio_deleted_at = ${now} where id in ${sql(due.map((r) => r.id))}`
      : { count: 0 };
    counts.withdrawn_consent_audio = done.count;
  }

  // FR-6: session uploads that never finished (no transcription started) after 24 h.
  {
    const due = await sql<{ id: string; storage_path: string | null }[]>`
      select id, storage_path from public.recordings
      where status = 'created' and kind in ('session', 'consult') and created_at < ${now}::timestamptz - ${hours(p.pendingRecordingHours)}::interval
      limit 1000`;
    const paths = due.map((r) => r.storage_path).filter((x): x is string => Boolean(x));
    if (paths.length) await remove("recordings", paths);
    const done = due.length ? await sql`delete from public.recordings where id in ${sql(due.map((r) => r.id))} and status = 'created'` : { count: 0 };
    counts.pending_recordings = done.count;
  }

  // 023 hand-off: unfinished document uploads after 1 h (object first, then the row).
  {
    const due = await sql<{ id: string; storage_path: string }[]>`
      select id, storage_path from public.documents
      where status = 'pending' and created_at < ${now}::timestamptz - ${hours(p.pendingDocumentHours)}::interval
      limit 1000`;
    if (due.length) await remove("documents", due.map((r) => r.storage_path));
    const done = due.length ? await sql`delete from public.documents where id in ${sql(due.map((r) => r.id))} and status = 'pending'` : { count: 0 };
    counts.pending_documents = done.count;
  }

  // 023 / 020 / 028 / FR-6: storage objects no live row points at (deleted/rejected rows, uploads never submitted).
  {
    const older = hours(p.orphanObjectHours);
    const sweeps: { bucket: string; key: string; rows: () => Promise<{ name: string }[]> }[] = [
      {
        bucket: "documents",
        key: "orphan_document_objects",
        rows: () => sql<{ name: string }[]>`
          select o.name from storage.objects o
          where o.bucket_id = 'documents' and o.created_at < ${now}::timestamptz - ${older}::interval
            and not exists (select 1 from public.documents d where d.storage_path = o.name and d.status in ('pending', 'ready'))
          limit 1000`,
      },
      {
        bucket: "recordings",
        key: "orphan_recording_objects",
        rows: () => sql<{ name: string }[]>`
          select o.name from storage.objects o
          where o.bucket_id = 'recordings' and o.created_at < ${now}::timestamptz - ${older}::interval
            and o.name ~ '^[0-9a-f-]{36}/[^/]+$'
            and not exists (select 1 from public.recordings r where r.storage_path = o.name)
            and not exists (select 1 from public.reports p where p.audio_path = o.name)
          limit 1000`,
      },
      {
        bucket: "consent-forms",
        key: "orphan_consent_scans",
        rows: () => sql<{ name: string }[]>`
          select o.name from storage.objects o
          where o.bucket_id = 'consent-forms' and o.created_at < ${now}::timestamptz - ${older}::interval
            and not exists (select 1 from public.consent_records c where c.paper_form_path = o.name)
          limit 1000`,
      },
      {
        bucket: "credentials",
        key: "orphan_credentials",
        rows: () => sql<{ name: string }[]>`
          select o.name from storage.objects o
          where o.bucket_id = 'credentials' and o.created_at < ${now}::timestamptz - ${older}::interval
            and not exists (select 1 from public.credential_submissions s where s.certificate_path = o.name)
          limit 1000`,
      },
      {
        bucket: "exports",
        key: "orphan_export_objects",
        rows: () => sql<{ name: string }[]>`
          select o.name from storage.objects o
          where o.bucket_id = 'exports' and o.created_at < ${now}::timestamptz - ${older}::interval
            and not exists (select 1 from public.privacy_exports e where e.storage_path = o.name and e.status = 'ready')
          limit 1000`,
      },
    ];
    for (const sweep of sweeps) {
      const names = (await sweep.rows()).map((r) => r.name);
      if (names.length) await remove(sweep.bucket, names);
      counts[sweep.key] = names.length;
    }
  }

  // FR-7: export files 7 days after they are ready.
  {
    const due = await sql<{ id: string; storage_path: string | null }[]>`
      select id, storage_path from public.privacy_exports
      where status = 'ready' and expires_at < ${now} limit 1000`;
    const paths = due.map((r) => r.storage_path).filter((x): x is string => Boolean(x));
    if (paths.length) await remove("exports", paths);
    const done = due.length
      ? await sql`
          update public.privacy_exports set status = 'expired', storage_path = null, deleted_at = ${now}
          where id in ${sql(due.map((r) => r.id))} and status = 'ready'`
      : { count: 0 };
    counts.expired_exports = done.count;
  }

  // FR-6: notifications.
  counts.in_app_notifications = (
    await sql`
      delete from public.notifications
      where channel = 'in_app' and created_at < ${now}::timestamptz - ${days(p.inAppNotificationDays)}::interval`
  ).count;
  counts.delivery_content = (
    await sql`
      update public.notifications set title = null, body = null
      where channel in ('email', 'whatsapp') and (title is not null or body is not null)
        and status in ('sent', 'skipped', 'dead', 'cancelled')
        and created_at < ${now}::timestamptz - ${days(p.deliveryContentDays)}::interval`
  ).count;

  // 033 FR-5: public check-ins that were never saved to a child, 30 days after they started (registry `screen_results`).
  counts.unsaved_screen_sessions = await purgeUnsavedScreenSessions(sql, now);

  // FR-6: website sign-ups after 24 months; audit events after 7 years (maintenance function).
  counts.pilot_signups = (
    await sql`delete from public.pilot_signups where created_at < ${now}::timestamptz - ${`${p.pilotSignupMonths} months`}::interval`
  ).count;
  {
    const [row] = await sql<{ n: number }[]>`
      select public.audit_purge_expired(${now}::timestamptz - ${`${p.auditYears} years`}::interval) as n`;
    counts.audit_events = row.n;
  }

  await auditStrict({
    actor: "system",
    action: "retention.run",
    entity: "retention",
    details: { counts, policy: p },
  });
  log.info("run complete", counts);
  return counts;
}
