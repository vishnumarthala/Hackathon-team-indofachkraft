// 041 FR-7 / FR-8 job runner: builds queued exports and executes approved deletion requests (and retries failed
// processor deletions). Driven by `POST /api/cron/privacy` (every 5 minutes, CRON_SECRET) and by `runPrivacyJobsSoon()`
// right after a request/approval (Next.js `after()`), like 032's outbox drain. Each job is lease-based and idempotent.
import { after } from "next/server";
import { logger, errorMessage } from "@/lib/log";
import { pg, type Sql } from "@/lib/pg";
import { executeDeletion, type DeletionDeps } from "./deletion";
import { buildExport, type BuildDeps } from "./export";

const log = logger("privacy.jobs");

/** A failed request (e.g. processor deletions still failing) is retried by each cron run up to this many times. */
export const MAX_DELETION_ATTEMPTS = 20;

export type PrivacyJobResult = { exports: Record<string, number>; deletions: Record<string, number> };

export async function runPrivacyJobs(
  opts: { sql?: Sql; exportIds?: string[]; deletionIds?: string[]; deps?: BuildDeps & DeletionDeps; limit?: number } = {},
): Promise<PrivacyJobResult> {
  const sql = opts.sql ?? (await pg());
  const limit = opts.limit ?? 10;
  const result: PrivacyJobResult = { exports: {}, deletions: {} };
  const bump = (bag: Record<string, number>, key: string | null) => {
    const k = key ?? "skipped";
    bag[k] = (bag[k] ?? 0) + 1;
  };

  const exportIds =
    opts.exportIds ??
    (
      await sql<{ id: string }[]>`
        select id from public.privacy_exports
        where status = 'queued' or (status = 'building' and locked_until < now())
        order by created_at limit ${limit}`
    ).map((r) => r.id);
  for (const id of exportIds) bump(result.exports, await buildExport(id, opts.deps, sql));

  const deletionIds =
    opts.deletionIds ??
    (
      await sql<{ id: string }[]>`
        select r.id from public.deletion_requests r
        where r.status = 'approved'
           or (r.status = 'in_progress' and (r.locked_until is null or r.locked_until < now()))
           or (r.status = 'failed' and r.attempts < ${MAX_DELETION_ATTEMPTS})
        order by r.created_at limit ${limit}`
    ).map((r) => r.id);
  for (const id of deletionIds) bump(result.deletions, await executeDeletion(id, opts.deps, sql));
  return result;
}

/** Runs the given jobs right after the current response (no-op outside a request scope; the cron picks them up). */
export function runPrivacyJobsSoon(ids: { exportIds?: string[]; deletionIds?: string[] }): void {
  try {
    after(async () => {
      try {
        await runPrivacyJobs({ exportIds: ids.exportIds ?? [], deletionIds: ids.deletionIds ?? [] });
      } catch (err) {
        log.error("immediate run failed", { error: errorMessage(err) });
      }
    });
  } catch {
    // Not inside a request scope.
  }
}
