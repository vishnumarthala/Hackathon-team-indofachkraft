// Outbox "job" topics (037): events that run server work (e.g. creating a Google Meet event) instead of fanning out
// notifications. Types only, so job implementations (lib/google/jobs.ts) and the registry (lib/notify/jobs.ts) do not
// import each other in a cycle.
import type { z } from "zod";
import type { Tx } from "@/lib/pg";
import type { OutboxEventRow } from "./types";

export type JobContext = {
  /** The fan-out transaction (a savepoint): writes commit with the event's completion. */
  sql: Tx;
  event: OutboxEventRow;
  /** 1 for the first attempt. */
  attempt: number;
};

export type JobFailureContext = JobContext & {
  error: unknown;
  /** No more attempts follow (permanent error or attempts used up). */
  final: boolean;
};

export type JobDefinition<S extends z.ZodType = z.ZodType<Record<string, unknown>>> = {
  payload: S;
  maxAttempts: number;
  /** Delay before attempt n + 1 (index n - 1); the last value repeats. */
  retryDelaysMs: readonly number[];
  /** Throws on failure (JobError with `permanent` = do not retry). Its writes roll back when it throws. */
  run(payload: z.output<S>, ctx: JobContext): Promise<void>;
  /** Runs after a failed attempt in its own savepoint (writes that must survive the failure). */
  onFailure?(payload: z.output<S>, ctx: JobFailureContext): Promise<void>;
};

export class JobError extends Error {
  constructor(
    readonly code: string,
    readonly permanent: boolean,
  ) {
    super(code);
    this.name = "JobError";
  }
}
