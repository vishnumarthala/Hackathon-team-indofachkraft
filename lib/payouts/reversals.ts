// Ticket 046 FR-5: reverse Route transfers before money goes back to the family, and when a consultation stops being
// billable. Used by
//   * 045's fee refunds (registerRefundPrecondition, lib/payouts/register.ts),
//   * 031's full refunds (lib/payments/jobs.ts, before the refund is created),
//   * the payout job (corrections that made a consultation not billable).
// Idempotent against Razorpay: an existing reversal of the transfer is reused (we only make full reversals), and a
// transfer whose creation outcome is unknown is looked up by our id first.
import { audit } from "@/lib/audit";
import { errorMessage, logger } from "@/lib/log";
import { pg, type Queryable } from "@/lib/pg";
import { getPaymentGateway, RazorpayApiError, type PaymentGateway } from "@/lib/payments/razorpay";
import { TRANSFER_BACKOFF_SECONDS } from "./fees";

const log = logger("payouts.reversals");

export class PayoutReversalPending extends Error {
  constructor(readonly reason: string) {
    super(`payout reversal pending: ${reason}`);
    this.name = "PayoutReversalPending";
  }
}

type ClaimedReversal = {
  payout_item_id: string;
  transfer_id: string;
  transfer_status: string;
  razorpay_transfer_id: string | null;
  razorpay_payment_id: string | null;
  amount_paise: number;
  reverse_reason: string | null;
};

export type ReversalResult = { reversed: number; voided: number; failed: number };

/** Reverses the items whose reversal was requested (optionally only those funded by one payment). */
export async function runReversals(
  sql: Queryable,
  gateway: PaymentGateway | null,
  opts: { paymentId?: string; limit?: number; orgIds?: string[] } = {},
): Promise<ReversalResult> {
  const result: ReversalResult = { reversed: 0, voided: 0, failed: 0 };
  const rows = await sql<ClaimedReversal[]>`
    select * from public.payouts_claim_reversals(${opts.limit ?? 50}, ${opts.paymentId ?? null}::uuid, ${opts.orgIds ?? null}::uuid[])`;
  if (!rows.length) return result;
  let gw: PaymentGateway;
  try {
    gw = gateway ?? getPaymentGateway();
  } catch (err) {
    log.error("reversals not possible: gateway not configured", { error: errorMessage(err) });
    await sql`update public.payout_items set locked_until = null where id in ${sql(rows.map((r) => r.payout_item_id))}`;
    result.failed += rows.length;
    return result;
  }
  for (const row of rows) {
    try {
      let transferId = row.razorpay_transfer_id;
      if (row.transfer_status === "creating" || !transferId) {
        // The attempt's outcome is unknown: find it by our id; not there = nothing moved.
        const found = row.razorpay_payment_id
          ? (await gw.listTransfers?.(row.razorpay_payment_id))?.find((t) => t.payout_transfer === row.transfer_id && t.status !== "failed")
          : undefined;
        if (!found) {
          await sql`select public.payouts_attempt_failed(${row.payout_item_id}, ${row.transfer_id}, true, 'not_created', ${TRANSFER_BACKOFF_SECONDS}::int[])`;
          result.voided += 1;
          continue;
        }
        await sql`select public.payouts_record_transfer(${row.transfer_id}, ${found.id}, ${found.status === "processed"})`;
        transferId = found.id;
      }
      if (!gw.createReversal) throw new Error("payment gateway without Route reversals");
      const existing = (await gw.listReversals?.(transferId))?.[0];
      const reversal = existing ?? (await gw.createReversal(transferId, { amountPaise: row.amount_paise, notes: { payout_item: row.payout_item_id } }));
      await sql`select public.payouts_record_reversal(${row.transfer_id}, ${reversal.id}, ${reversal.amount || row.amount_paise})`;
      result.reversed += 1;
      await audit({
        actor: "system",
        actorRole: "system",
        action: "payouts.transfer_reversed",
        entity: "payout_item",
        entityId: row.payout_item_id,
        details: { reason: row.reverse_reason, amount_paise: row.amount_paise, transfer_last4: transferId.slice(-4) },
      });
    } catch (err) {
      const code = err instanceof RazorpayApiError ? `${err.status} ${err.code}` : errorMessage(err);
      log.error("reversal failed", { item: row.payout_item_id, error: code });
      await sql`update public.payout_items set locked_until = null, failure_reason = ${`reversal: ${code}`.slice(0, 300)}, updated_at = now()
                where id = ${row.payout_item_id}`;
      result.failed += 1;
    }
  }
  return result;
}

export type RefundScope = {
  /** payments.id the refund comes from. */
  paymentId: string;
  amountPaise: number;
  /** The consultation being refunded (045 session refunds), if any. */
  appointmentId: string | null;
  /** 031 full refund of the payment. */
  full: boolean;
  /** The fee refund being processed (not counted against itself). */
  excludeRefundId?: string | null;
};

/**
 * FR-5: before a refund goes to Razorpay, the matching transfers must be reversed. Marks them, reverses them now and
 * throws PayoutReversalPending when something is still in flight, so the refund job retries later (its back-off).
 */
export async function reverseBeforeRefund(scope: RefundScope, opts: { gateway?: PaymentGateway; sql?: Queryable } = {}): Promise<void> {
  const sql = opts.sql ?? (await pg());
  const prepare = async () => {
    const [row] = await sql<{ r: { ready: boolean; pending: number; reason?: string } }[]>`
      select public.payouts_prepare_refund(${scope.paymentId}, ${scope.amountPaise}, ${scope.appointmentId}::uuid, ${scope.full},
                                           ${scope.excludeRefundId ?? null}::uuid) as r`;
    return row.r;
  };
  let state = await prepare();
  if (state.ready) return;
  if (state.reason) throw new PayoutReversalPending(state.reason);
  await runReversals(sql, opts.gateway ?? null, { paymentId: scope.paymentId });
  state = await prepare();
  if (!state.ready) throw new PayoutReversalPending(state.reason ?? "transfer_in_flight");
}
