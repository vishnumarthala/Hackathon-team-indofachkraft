// 041 FR-12: operational health. `checkDatabase()` backs the public `GET /api/health`; `opsOverview()` the platform
// admin page /admin/ops (outbox backlog and dead deliveries, last retention run, privacy jobs, stuck recordings).
// Counts and ids only - no personal data.
import { pg, type Sql } from "@/lib/pg";

export const STUCK_MINUTES = 30;

/** `select 1` with a timeout; false when the database cannot be reached. */
export async function checkDatabase(sql?: Sql, timeoutMs = 3000): Promise<boolean> {
  try {
    const db = sql ?? (await pg());
    const ping = db`select 1 as ok`.then((rows) => rows[0]?.ok === 1);
    const timeout = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs));
    return await Promise.race([ping, timeout]);
  } catch {
    return false;
  }
}

export type OpsOverview = {
  outbox: { pendingEvents: number; oldestPendingMinutes: number | null; notifications: Record<string, number> };
  retention: { lastRunAt: Date | null; counts: Record<string, number> | null };
  privacy: {
    openRequests: number;
    failedRequests: number;
    failedExports: number;
    queuedExports: number;
    failedProcessorDeletions: { id: string; request_id: string; processor: string; status: string; response_code: number | null; attempts: number; attempted_at: Date | null }[];
  };
  stuckRecordings: { id: string; case_id: string; status: string; minutes: number }[];
};

export async function opsOverview(sql?: Sql): Promise<OpsOverview> {
  const db = sql ?? (await pg());
  const [events] = await db<{ pending: number; oldest: number | null }[]>`
    select count(*)::int as pending,
           (extract(epoch from now() - min(deliver_after)) / 60)::int as oldest
    from public.outbox_events where status = 'pending' and deliver_after <= now()`;
  const statusRows = await db<{ status: string; n: number }[]>`
    select status, count(*)::int as n from public.notifications
    where status in ('pending', 'sending', 'failed', 'dead') group by status`;
  const [retention] = await db<{ created_at: Date; details: { counts?: Record<string, number> } }[]>`
    select created_at, details from public.audit_events where action = 'retention.run' order by id desc limit 1`;
  const [requests] = await db<{ open: number; failed: number }[]>`
    select count(*) filter (where status in ('requested', 'approved', 'in_progress'))::int as open,
           count(*) filter (where status = 'failed')::int as failed
    from public.deletion_requests`;
  const [exports] = await db<{ failed: number; queued: number }[]>`
    select count(*) filter (where status = 'failed')::int as failed,
           count(*) filter (where status in ('queued', 'building'))::int as queued
    from public.privacy_exports`;
  const processors = await db<OpsOverview["privacy"]["failedProcessorDeletions"]>`
    select id, request_id, processor, status, response_code, attempts, attempted_at from public.processor_deletions
    where status = 'failed' or (status = 'pending' and created_at < now() - interval '1 hour')
    order by attempted_at desc nulls last limit 50`;
  const stuck = await db<OpsOverview["stuckRecordings"]>`
    select id, case_id, status, (extract(epoch from now() - status_changed_at) / 60)::int as minutes
    from public.recordings
    where status in ('transcribing', 'extracting') and status_changed_at < now() - ${`${STUCK_MINUTES} minutes`}::interval
    order by status_changed_at limit 50`;
  return {
    outbox: {
      pendingEvents: events.pending,
      oldestPendingMinutes: events.oldest,
      notifications: Object.fromEntries(statusRows.map((r) => [r.status, r.n])),
    },
    retention: { lastRunAt: retention?.created_at ?? null, counts: retention?.details?.counts ?? null },
    privacy: {
      openRequests: requests.open,
      failedRequests: requests.failed,
      failedExports: exports.failed,
      queuedExports: exports.queued,
      failedProcessorDeletions: processors,
    },
    stuckRecordings: stuck,
  };
}
