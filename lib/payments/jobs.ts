// Ticket 031 FR-6 / FR-7 refund job (`payment.refund_needed`): payments in `refund_pending` are the queue. Each run
// claims due rows under a lease (for update skip locked), asks the gateway for a full refund and records the result:
// `processed` -> refunded + guardian notification (payment.refunded) + strict audit, one transaction; `pending` -> keep
// polling (the `refund.processed` webhook usually finishes it first); errors -> retry with back-off.
// Idempotent against Razorpay: an existing refund of the payment is reused before a new one is created. 046: transfers
// of the payment to the centre (Razorpay Route) are reversed first.
// Driven by POST /api/cron/payments (every minute), `npm run outbox:run` and runPaymentJobsSoon() (Next.js after()).
import { after } from "next/server";
import { errorMessage, logger } from "@/lib/log";
import { drainSoon } from "@/lib/notify/outbox";
import { pg, type Sql } from "@/lib/pg";
import { getPaymentGateway, RazorpayApiError, type GatewayRefund, type PaymentGateway } from "./razorpay";
import { markPaymentRefunded } from "./store";
import { reverseBeforeRefund } from "@/lib/payouts/reversals";

const log = logger("payments.jobs");

export const REFUND_LEASE_SECONDS = 120;
/** Back-off after a failed attempt: 1 min, 5 min, 30 min, 2 h, then every 12 h (ops see refund_last_error). */
export const REFUND_BACKOFF_SECONDS = [60, 300, 1800, 7200, 43200];
export const REFUND_POLL_SECONDS = 300;

export type PaymentJobResult = { refunded: number; pending: number; failed: number };

type Claimed = { id: string; razorpay_payment_id: string; amount_paise: number; refund_id: string | null; refund_attempts: number; refund_locked_until: Date };

export function refundBackoffSeconds(attempts: number): number {
  return REFUND_BACKOFF_SECONDS[Math.min(Math.max(attempts, 1), REFUND_BACKOFF_SECONDS.length) - 1];
}

async function refundFor(gateway: PaymentGateway, row: Claimed): Promise<GatewayRefund> {
  if (row.refund_id) return gateway.fetchRefund(row.razorpay_payment_id, row.refund_id);
  const existing = (await gateway.listRefunds(row.razorpay_payment_id)).find((r) => r.status !== "failed");
  if (existing) return existing;
  return gateway.createRefund(row.razorpay_payment_id, { amountPaise: row.amount_paise, receipt: `refund-${row.id}`.slice(0, 40) });
}

export async function runPaymentJobs(opts: { sql?: Sql; gateway?: PaymentGateway; paymentIds?: string[]; limit?: number } = {}): Promise<PaymentJobResult> {
  const sql = opts.sql ?? (await pg());
  const result: PaymentJobResult = { refunded: 0, pending: 0, failed: 0 };
  const ids = opts.paymentIds ?? null;
  const claimed = await sql<Claimed[]>`
    update public.payments p
    set refund_locked_until = now() + make_interval(secs => ${REFUND_LEASE_SECONDS}), refund_attempts = p.refund_attempts + 1, updated_at = now()
    where p.id in (
      select id from public.payments
      where status = 'refund_pending'
        and coalesce(refund_next_attempt_at, now()) <= now()
        and (refund_locked_until is null or refund_locked_until < now())
        and (${ids}::uuid[] is null or id = any(${ids}::uuid[]))
      order by refund_next_attempt_at nulls first
      limit ${opts.limit ?? 20}
      for update skip locked)
    returning p.id, p.razorpay_payment_id, p.amount_paise, p.refund_id, p.refund_attempts, p.refund_locked_until`;
  if (!claimed.length) return result;

  let gateway: PaymentGateway;
  try {
    gateway = opts.gateway ?? getPaymentGateway();
  } catch (err) {
    log.error("refunds not possible: gateway not configured", { error: errorMessage(err) });
    await sql`update public.payments set refund_locked_until = null, refund_last_error = 'not_configured',
              refund_next_attempt_at = now() + interval '5 minutes' where id in ${sql(claimed.map((c) => c.id))}`;
    result.failed += claimed.length;
    return result;
  }

  const eventIds: string[] = [];
  for (const row of claimed) {
    try {
      // 046 FR-5: a Route transfer of this payment to the centre is reversed before the family is refunded (throws while
      // a reversal is still pending: retried with the back-off below).
      await reverseBeforeRefund({ paymentId: row.id, amountPaise: row.amount_paise, appointmentId: null, full: true }, { gateway, sql });
      const refund = await refundFor(gateway, row);
      if (refund.status === "processed") {
        const done = await markPaymentRefunded(row.razorpay_payment_id, refund.id);
        if (done.event_id) eventIds.push(done.event_id);
        result.refunded += 1;
      } else if (refund.status === "pending") {
        await sql`update public.payments set refund_id = ${refund.id}, refund_locked_until = null, refund_last_error = null,
                  refund_next_attempt_at = now() + make_interval(secs => ${REFUND_POLL_SECONDS}), updated_at = now()
                  where id = ${row.id} and refund_attempts = ${row.refund_attempts} and status = 'refund_pending'`;
        result.pending += 1;
      } else {
        // The refund failed at Razorpay: forget it, try a new one after the back-off.
        await sql`update public.payments set refund_id = null, refund_locked_until = null, refund_last_error = 'refund_failed',
                  refund_next_attempt_at = now() + make_interval(secs => ${refundBackoffSeconds(row.refund_attempts)}), updated_at = now()
                  where id = ${row.id} and refund_attempts = ${row.refund_attempts} and status = 'refund_pending'`;
        result.failed += 1;
      }
    } catch (err) {
      const code = err instanceof RazorpayApiError ? `${err.status} ${err.code}` : errorMessage(err);
      log.error("refund attempt failed", { payment: row.id, attempts: row.refund_attempts, error: code });
      await sql`update public.payments set refund_locked_until = null, refund_last_error = ${code.slice(0, 500)},
                refund_next_attempt_at = now() + make_interval(secs => ${refundBackoffSeconds(row.refund_attempts)}), updated_at = now()
                where id = ${row.id} and refund_attempts = ${row.refund_attempts} and status = 'refund_pending'`;
      result.failed += 1;
    }
  }
  if (eventIds.length) drainSoon(eventIds);
  return result;
}

/** Runs the refund job for these payments right after the current response (no-op outside a request; cron picks them up). */
export function runPaymentJobsSoon(paymentIds: string[]): void {
  if (!paymentIds.length) return;
  try {
    after(async () => {
      try {
        await runPaymentJobs({ paymentIds });
      } catch (err) {
        log.error("immediate refund run failed", { error: errorMessage(err) });
      }
    });
  } catch {
    // Not inside a request scope.
  }
}
