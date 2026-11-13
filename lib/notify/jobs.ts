// Outbox job registry and runner (037 FR-3). The outbox worker (lib/notify/worker.ts) hands events whose topic is a
// job here instead of fanning them out. Retry bookkeeping lives in `outbox_job_attempts`; a failed attempt moves the
// event's `deliver_after` (back-off) and keeps it `pending`; success or a final failure marks it `fanned_out`.
// Runs inside the fan-out transaction while the event row is locked (`for update skip locked`), so two workers never
// run the same job at once. Logs carry ids, codes and counts only.
import { MEET_JOBS } from "@/lib/google/jobs";
import type { Tx } from "@/lib/pg";
import { JobError, type JobDefinition } from "./job-types";
import { sanitizeError } from "./retry";
import type { OutboxEventRow } from "./types";

const JOBS: Record<string, JobDefinition> = { ...MEET_JOBS } as Record<string, JobDefinition>;

export function getJob(topic: string): JobDefinition | null {
  return Object.prototype.hasOwnProperty.call(JOBS, topic) ? JOBS[topic] : null;
}

function log(message: string) {
  console.info(`[outbox-job] ${message}`);
}

function errorCode(err: unknown): string {
  if (err instanceof JobError) return err.code;
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Za-z0-9_.-]{1,60}$/.test(code) ? code : sanitizeError(err).slice(0, 120);
}

export function retryDelay(job: JobDefinition, attempt: number): number {
  const delays = job.retryDelaysMs;
  return delays[Math.min(Math.max(attempt - 1, 0), delays.length - 1)] ?? 60_000;
}

/** Runs one attempt of a job event. Returns 0 (no notifications are created by the job event itself). */
export async function runJob(tx: Tx, event: OutboxEventRow, job: JobDefinition): Promise<number> {
  const markDone = () => tx`update public.outbox_events set status = 'fanned_out', fanned_out_at = now() where id = ${event.id}`;
  const parsed = job.payload.safeParse(event.payload);
  if (!parsed.success) {
    log(`event ${event.id}: invalid payload for ${event.topic}, dropped`);
    await markDone();
    return 0;
  }
  const [prev] = await tx<{ attempts: number }[]>`select attempts from public.outbox_job_attempts where event_id = ${event.id}`;
  const attempt = (prev?.attempts ?? 0) + 1;
  const record = (error: string | null) => tx`
    insert into public.outbox_job_attempts (event_id, attempts, last_error, updated_at)
    values (${event.id}, ${attempt}, ${error}, now())
    on conflict (event_id) do update set attempts = excluded.attempts, last_error = excluded.last_error, updated_at = now()`;

  try {
    await tx.savepoint((sp) => job.run(parsed.data, { sql: sp, event, attempt }));
    await record(null);
    await markDone();
    return 0;
  } catch (error) {
    const permanent = error instanceof JobError && error.permanent;
    const final = permanent || attempt >= job.maxAttempts;
    const code = errorCode(error);
    if (job.onFailure) {
      try {
        await tx.savepoint((sp) => job.onFailure!(parsed.data, { sql: sp, event, attempt, error, final }));
      } catch (failureError) {
        log(`event ${event.id}: failure handler error ${errorCode(failureError)}`);
      }
    }
    await record(code.slice(0, 500));
    if (final) {
      await markDone();
    } else {
      await tx`update public.outbox_events set deliver_after = now() + make_interval(secs => ${retryDelay(job, attempt) / 1000}) where id = ${event.id}`;
    }
    log(`event ${event.id}: ${event.topic} attempt ${attempt} failed (${code})${final ? ", giving up" : ", will retry"}`);
    return 0;
  }
}
