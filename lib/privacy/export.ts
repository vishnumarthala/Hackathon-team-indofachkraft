// 041 FR-7: guardian data export. `requestExport` (strict audit, limits) -> job `buildExport` (ZIP in the private
// `exports` bucket, `privacy.export_ready` notification in the same transaction as `ready`) -> `exportDownloadUrl`
// (strict audit, 10-minute signed URL, requester only). Exports expire after 7 days (retention.ts).
// Only what the requesting guardian can already see is included: every section comes from a registry exporter
// (lib/privacy/registry.ts), which must apply the guardian's portal rules.
import { auditStrict, type SessionAuditActor } from "@/lib/audit";
import { supabaseAdmin } from "@/lib/db";
import { errorMessage, logger } from "@/lib/log";
import { drainSoon, enqueue } from "@/lib/notify/outbox";
import { pg, type Sql } from "@/lib/pg";
import { REGISTRY } from "./registry";
import { retentionPolicy } from "./retention";
import { buildZip, type ZipEntry } from "./zip";

const log = logger("privacy.export");

export const EXPORTS_BUCKET = "exports";
export const EXPORT_URL_TTL_SEC = 600;
export const EXPORTS_PER_DAY = 3;
export const EXPORT_MAX_ATTEMPTS = 3;
export const EXPORT_RUNNING = "An export is already being prepared";
export const EXPORT_LIMIT = "You can request 3 downloads per day. Please try again tomorrow.";

export type ExportStatus = "queued" | "building" | "ready" | "failed" | "expired";
export type ExportRow = {
  id: string;
  child_id: string;
  requested_by: string;
  status: ExportStatus;
  storage_path: string | null;
  size_bytes: string | null;
  file_count: number | null;
  attempts: number;
  created_at: Date;
  completed_at: Date | null;
  expires_at: Date | null;
  downloaded_at: Date | null;
};

export type RequestExportResult = { ok: true; exportId: string } | { ok: false; status: 429; error: string };

/** FR-7: max 1 queued/building export per child and 3 per child per day (429), strict audit in the same transaction. */
export async function requestExport(
  childId: string,
  guardianUserId: string,
  actor: SessionAuditActor,
  sql?: Sql,
): Promise<RequestExportResult> {
  const db = sql ?? (await pg());
  return db.begin(async (tx) => {
    // Serialises concurrent requests for the same child.
    await tx`select id from public.children where id = ${childId} for update`;
    const [counts] = await tx<{ running: number; today: number }[]>`
      select count(*) filter (where status in ('queued', 'building'))::int as running,
             count(*) filter (where created_at > now() - interval '24 hours')::int as today
      from public.privacy_exports where child_id = ${childId}`;
    if (counts.running > 0) return { ok: false, status: 429, error: EXPORT_RUNNING } as const;
    if (counts.today >= EXPORTS_PER_DAY) return { ok: false, status: 429, error: EXPORT_LIMIT } as const;
    const [row] = await tx<{ id: string }[]>`
      insert into public.privacy_exports (child_id, requested_by) values (${childId}, ${guardianUserId}) returning id`;
    await auditStrict(
      { ...actor, childId, action: "privacy.export_requested", entity: "privacy_export", entityId: row.id },
      tx,
    );
    return { ok: true, exportId: row.id } as const;
  });
}

export async function listExports(childId: string, guardianUserId: string, sql?: Sql): Promise<ExportRow[]> {
  const db = sql ?? (await pg());
  return db<ExportRow[]>`
    select id, child_id, requested_by, status, storage_path, size_bytes, file_count, attempts, created_at, completed_at,
           expires_at, downloaded_at
    from public.privacy_exports
    where child_id = ${childId} and requested_by = ${guardianUserId}
    order by created_at desc limit 10`;
}

export type ObjectDownloader = (bucket: string, path: string) => Promise<Uint8Array | null>;
export type ObjectUploader = (bucket: string, path: string, body: Buffer) => Promise<void>;

const downloadObject: ObjectDownloader = async (bucket, path) => {
  const { data, error } = await supabaseAdmin().storage.from(bucket).download(path);
  if (error || !data) return null;
  return new Uint8Array(await data.arrayBuffer());
};

const uploadObject: ObjectUploader = async (bucket, path, body) => {
  const { error } = await supabaseAdmin()
    .storage.from(bucket)
    .upload(path, body, { contentType: "application/zip", upsert: true });
  if (error) throw new Error(`Could not store the export: ${error.message}`);
};

export type BuildDeps = { download?: ObjectDownloader; upload?: ObjectUploader };

/** The guardian-visible content of the child as `{ child.json, files }` (exposed for tests and the job). */
export async function collectExport(sql: Sql, childId: string, guardianUserId: string, download: ObjectDownloader) {
  const sections: Record<string, unknown> = {};
  const entries: ZipEntry[] = [];
  const missing: string[] = [];
  for (const category of REGISTRY) {
    if (!category.export) continue;
    const section = await category.export({ sql, childId, guardianUserId });
    if (!section) continue;
    sections[category.key] = section.data;
    for (const file of section.files ?? []) {
      const bytes = await download(file.bucket, file.objectPath);
      if (bytes) entries.push({ name: file.path, data: bytes });
      else missing.push(file.path);
    }
  }
  const childJson = {
    format: "doctornearme-child-export/v1",
    generated_at: new Date().toISOString(),
    child_id: childId,
    note: "Everything DoctorNearMe holds about this child that you can see in the app. Files are in documents/.",
    sections,
    ...(missing.length ? { files_unavailable: missing } : {}),
  };
  entries.unshift({ name: "child.json", data: Buffer.from(JSON.stringify(childJson, null, 2), "utf8") });
  return { childJson, entries };
}

/**
 * Job step (idempotent, resumable): claims one queued export (or a `building` one whose lease expired), builds the
 * ZIP, stores it, then marks it ready and enqueues the notification in one transaction. Returns the new status, or
 * null when there was nothing to claim (already ready, another worker has it).
 */
export async function buildExport(exportId: string, deps: BuildDeps = {}, sql?: Sql): Promise<ExportStatus | null> {
  const db = sql ?? (await pg());
  const [job] = await db<{ id: string; child_id: string; requested_by: string; attempts: number }[]>`
    update public.privacy_exports
    set status = 'building', attempts = attempts + 1, started_at = coalesce(started_at, now()),
        locked_until = now() + interval '10 minutes'
    where id = ${exportId}
      and (status = 'queued' or (status = 'building' and locked_until < now()))
    returning id, child_id, requested_by, attempts`;
  if (!job) return null;
  try {
    // The requester must still be linked; otherwise nothing is built.
    const [link] = await db`
      select 1 from public.guardian_links gl join public.children c on c.id = gl.child_id and c.deleted_at is null
      where gl.child_id = ${job.child_id} and gl.user_id = ${job.requested_by} and gl.status = 'active'`;
    if (!link) throw new Error("requester no longer linked");
    const { entries } = await collectExport(db, job.child_id, job.requested_by, deps.download ?? downloadObject);
    const zip = buildZip(entries);
    const path = `${job.child_id}/${job.id}.zip`;
    await (deps.upload ?? uploadObject)(EXPORTS_BUCKET, path, zip);
    const days = retentionPolicy().exportDays;
    const eventId = await db.begin(async (tx) => {
      await tx`
        update public.privacy_exports
        set status = 'ready', storage_path = ${path}, size_bytes = ${zip.length}, file_count = ${entries.length},
            completed_at = now(), expires_at = now() + ${`${days} days`}::interval, locked_until = null, last_error = null
        where id = ${job.id}`;
      return enqueue(tx, {
        topic: "privacy.export_ready",
        aggregateType: "privacy_export",
        aggregateId: job.id,
        payload: { export_id: job.id, child_id: job.child_id },
        dedupKey: `privacy.export_ready:${job.id}`,
      });
    });
    drainSoon([eventId]);
    log.info("export ready", { export_id: job.id, files: entries.length, bytes: zip.length });
    return "ready";
  } catch (err) {
    const final = job.attempts >= EXPORT_MAX_ATTEMPTS || errorMessage(err) === "requester no longer linked";
    await db`
      update public.privacy_exports
      set status = ${final ? "failed" : "queued"}, locked_until = null, last_error = ${errorMessage(err).slice(0, 300)}
      where id = ${job.id}`;
    log.error("export failed", { export_id: job.id, attempt: job.attempts, error: errorMessage(err) });
    return final ? "failed" : "queued";
  }
}

export type DownloadResult = { ok: true; url: string } | { ok: false; status: 404; error: string };

/**
 * FR-7: only the guardian who requested the export, while still linked to the child, and only while it is ready and
 * not expired; anyone else gets 404. The download is audited (strict) before the 10-minute signed URL is minted.
 */
export async function exportDownloadUrl(exportId: string, guardianUserId: string, actor: SessionAuditActor, sql?: Sql): Promise<DownloadResult> {
  const db = sql ?? (await pg());
  const row = await db.begin(async (tx) => {
    const [found] = await tx<{ id: string; child_id: string; storage_path: string }[]>`
      select e.id, e.child_id, e.storage_path from public.privacy_exports e
      join public.guardian_links gl on gl.child_id = e.child_id and gl.user_id = e.requested_by and gl.status = 'active'
      join public.children c on c.id = e.child_id and c.deleted_at is null
      where e.id = ${exportId} and e.requested_by = ${guardianUserId} and e.status = 'ready'
        and e.expires_at > now() and e.storage_path is not null
      for update of e`;
    if (!found) return null;
    await tx`update public.privacy_exports set downloaded_at = now() where id = ${found.id}`;
    await auditStrict(
      { ...actor, childId: found.child_id, action: "privacy.export_downloaded", entity: "privacy_export", entityId: found.id },
      tx,
    );
    return found;
  });
  if (!row) return { ok: false, status: 404, error: "Export not found" };
  const { data, error } = await supabaseAdmin()
    .storage.from(EXPORTS_BUCKET)
    .createSignedUrl(row.storage_path, EXPORT_URL_TTL_SEC, { download: `doctornearme-export-${row.id.slice(0, 8)}.zip` });
  if (error || !data?.signedUrl) throw new Error("Could not create the download link");
  return { ok: true, url: data.signedUrl };
}
