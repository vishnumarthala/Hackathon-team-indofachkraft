// Ticket 031: payment data access. Server-only (shared Postgres pool, lib/pg.ts). Every caller must have passed its
// gate first (guardian owner of the appointment, signed webhook, cron secret). Appointment state moves only inside the
// SQL functions of supabase/migrations/20261113003100_payments.sql, which use 030's booking helpers.
import { auditStrict, type AuditEvent } from "@/lib/audit";
import { pg, type Queryable, type Tx } from "@/lib/pg";
import { getPaymentGateway, razorpaySettings, type PaymentGateway, type RazorpaySettings } from "./razorpay";
import type { ParsedWebhook } from "./webhook";
import { applyLinkPaid, closeLink } from "@/lib/fees/store";
import { enqueue } from "@/lib/notify/outbox";
import { TRANSFER_BACKOFF_SECONDS } from "@/lib/payouts/fees";

export const PAYMENT_STATUSES = ["created", "authorized", "captured", "failed", "refund_pending", "refunded"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];
export type RefundReason =
  | "slot_unavailable"
  | "appointment_cancelled"
  | "provider_cancelled"
  | "guardian_cancelled"
  | "system_cancelled"
  | "amount_mismatch"
  | "external"
  // 045
  | "not_billable"
  | "session_refund";

export type PaymentRow = {
  id: string;
  appointment_id: string;
  gateway: "razorpay" | "demo";
  razorpay_order_id: string;
  /** 045: DoctorNearMe receipt number once captured. */
  receipt_no: string | null;
  razorpay_payment_id: string | null;
  amount_paise: number;
  currency: "INR";
  status: PaymentStatus;
  refund_id: string | null;
  refund_reason: RefundReason | null;
  failure_reason: string | null;
  captured_at: string | null;
  refunded_at: string | null;
  created_at: string;
};

const iso = (v: unknown): string | null => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : String(v));

function toRow(r: Record<string, unknown>): PaymentRow {
  return {
    id: String(r.id),
    appointment_id: String(r.appointment_id),
    gateway: r.gateway as PaymentRow["gateway"],
    razorpay_order_id: String(r.razorpay_order_id),
    receipt_no: (r.receipt_no as string | null) ?? null,
    razorpay_payment_id: (r.razorpay_payment_id as string | null) ?? null,
    amount_paise: Number(r.amount_paise),
    currency: "INR",
    status: r.status as PaymentStatus,
    refund_id: (r.refund_id as string | null) ?? null,
    refund_reason: (r.refund_reason as RefundReason | null) ?? null,
    failure_reason: (r.failure_reason as string | null) ?? null,
    captured_at: iso(r.captured_at),
    refunded_at: iso(r.refunded_at),
    created_at: iso(r.created_at) as string,
  };
}

const COLUMNS = "id, appointment_id, gateway, razorpay_order_id, receipt_no, razorpay_payment_id, amount_paise, currency, status, refund_id, refund_reason, failure_reason, captured_at, refunded_at, created_at";

/** The appointment's payment: the non-failed one, else the latest failed attempt. */
export async function getPaymentForAppointment(appointmentId: string, sql?: Queryable): Promise<PaymentRow | null> {
  const db = sql ?? (await pg());
  const rows = await db.unsafe(
    `select ${COLUMNS} from public.payments where appointment_id = $1 order by (status <> 'failed') desc, created_at desc limit 1`,
    [appointmentId],
  );
  return rows[0] ? toRow(rows[0]) : null;
}

/** appointment id -> its payment (same rule as getPaymentForAppointment), for list pages. */
export async function listPaymentsForAppointments(appointmentIds: string[]): Promise<Map<string, PaymentRow>> {
  const out = new Map<string, PaymentRow>();
  if (!appointmentIds.length) return out;
  const sql = await pg();
  const rows = await sql.unsafe(
    `select distinct on (appointment_id) ${COLUMNS} from public.payments
     where appointment_id = any($1::uuid[])
     order by appointment_id, (status <> 'failed') desc, created_at desc`,
    [appointmentIds],
  );
  for (const r of rows) out.set(String(r.appointment_id), toRow(r));
  return out;
}

export type OwnedPayment = PaymentRow & { org_id: string; child_id: string | null; provider_profile_id: string };

/** The payment for an order id, only when its appointment was booked by `guardianId` (otherwise null -> 404). */
export async function findGuardianPaymentByOrder(orderId: string, guardianId: string): Promise<OwnedPayment | null> {
  const sql = await pg();
  const rows = await sql.unsafe(
    `select ${COLUMNS.split(", ").map((c) => `p.${c}`).join(", ")}, a.org_id, a.child_id, a.provider_profile_id
     from public.payments p join public.appointments a on a.id = p.appointment_id
     where p.razorpay_order_id = $1 and a.guardian_user_id = $2`,
    [orderId, guardianId],
  );
  const r = rows[0];
  return r ? { ...toRow(r), org_id: String(r.org_id), child_id: (r.child_id as string | null) ?? null, provider_profile_id: String(r.provider_profile_id) } : null;
}

// ---------- order (FR-3) ----------

export type OrderResult =
  | { ok: true; payment: PaymentRow; keyId: string; created: boolean }
  | { ok: false; code: "already_paid" };

/**
 * FR-3: one Razorpay order per appointment. An existing `created` (or failed/authorized: retry on the same order)
 * payment is returned; otherwise the gateway creates the order (amount = fee_inr * 100, receipt = appointment id,
 * notes.appointment_id) and the row is inserted. Serialised per appointment (advisory lock), so a double click cannot
 * create two orders. The caller checked owner, status and expiry.
 */
export async function createPaymentOrder(
  input: { appointmentId: string; amountPaise: number },
  deps: { gateway?: PaymentGateway; settings?: RazorpaySettings } = {},
): Promise<OrderResult> {
  const settings = deps.settings ?? razorpaySettings();
  const gateway = deps.gateway ?? getPaymentGateway(settings);
  const sql = await pg();
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${`payment-order:${input.appointmentId}`}, 0))`;
    const existing = await getPaymentForAppointment(input.appointmentId, tx);
    if (existing && ["captured", "refund_pending", "refunded"].includes(existing.status)) return { ok: false, code: "already_paid" } as const;
    if (existing) {
      if (existing.status === "failed") {
        const [row] = await tx.unsafe(
          `update public.payments set status = 'created', updated_at = now() where id = $1 and status = 'failed' returning ${COLUMNS}`,
          [existing.id],
        );
        return { ok: true, payment: row ? toRow(row) : existing, keyId: settings.keyId, created: false } as const;
      }
      return { ok: true, payment: existing, keyId: settings.keyId, created: false } as const;
    }
    const order = await gateway.createOrder({
      amountPaise: input.amountPaise,
      receipt: input.appointmentId,
      notes: { appointment_id: input.appointmentId },
    });
    if (order.amount !== input.amountPaise) throw new Error("razorpay order amount mismatch");
    const [row] = await tx.unsafe(
      `insert into public.payments (appointment_id, gateway, razorpay_order_id, amount_paise, currency, status)
       values ($1, $2, $3, $4, 'INR', 'created') returning ${COLUMNS}`,
      [input.appointmentId, gateway.kind, order.id, input.amountPaise],
    );
    return { ok: true, payment: toRow(row), keyId: settings.keyId, created: true } as const;
  });
}

// ---------- capture (FR-4 / FR-5 / FR-6) ----------

export type CaptureOutcome =
  | "confirmed"
  | "late_confirmed"
  | "already_captured"
  | "already_confirmed"
  | "duplicate_payment"
  | `refund_${RefundReason}`;

export type CaptureResult = {
  payment_id: string;
  appointment_id: string;
  outcome: CaptureOutcome;
  payment_status: PaymentStatus;
  appointment_status: string;
  event_id: string | null;
  refund_reason: RefundReason | null;
};

export type CaptureInput = {
  orderId: string;
  paymentId: string;
  /** Webhook only: the captured amount (a mismatch is refunded). */
  amountPaise?: number | null;
  /** The guardian (checkout handler); null = system (webhook). */
  actorUserId?: string | null;
  source: "checkout" | "webhook" | "demo";
};

async function appointmentScope(tx: Queryable, appointmentId: string): Promise<{ org_id: string | null; child_id: string | null }> {
  const [row] = await tx<{ org_id: string; child_id: string | null }[]>`select org_id, child_id from public.appointments where id = ${appointmentId}`;
  return { org_id: row?.org_id ?? null, child_id: row?.child_id ?? null };
}

/**
 * FR-6 `apply_payment_captured`: the one path for the checkout handler and the `payment.captured` webhook. The SQL
 * function and the strict audit row (041) commit together; replays are no-ops (no second confirmation, no audit row).
 * Pass `tx` to run inside the caller's transaction (webhook dedup).
 */
export async function applyPaymentCaptured(input: CaptureInput, tx?: Tx): Promise<CaptureResult> {
  const run = async (t: Tx): Promise<CaptureResult> => {
    const [row] = await t<{ r: Record<string, unknown> }[]>`
      select public.payment_apply_captured(${input.orderId}, ${input.paymentId}, ${input.amountPaise ?? null}::int,
                                           ${input.actorUserId ?? null}::uuid) as r`;
    const r = row.r;
    const result: CaptureResult = {
      payment_id: String(r.payment_id),
      appointment_id: String(r.appointment_id),
      outcome: r.outcome as CaptureOutcome,
      payment_status: r.payment_status as PaymentStatus,
      appointment_status: String(r.appointment_status),
      event_id: r.event_id === null || r.event_id === undefined ? null : String(r.event_id),
      refund_reason: (r.refund_reason as RefundReason | null | undefined) ?? null,
    };
    if (result.outcome !== "already_captured") {
      const scope = await appointmentScope(t, result.appointment_id);
      const actor: Pick<AuditEvent, "actor" | "actorUserId" | "actorRole"> = input.actorUserId
        ? { actorUserId: input.actorUserId, actorRole: "guardian" }
        : { actor: "system", actorRole: "system" };
      await auditStrict(
        {
          ...actor,
          orgId: scope.org_id,
          childId: scope.child_id,
          action: "payment.captured",
          entity: "payment",
          entityId: result.payment_id,
          details: { appointment_id: result.appointment_id, outcome: result.outcome, source: input.source },
        },
        t,
      );
    }
    return result;
  };
  if (tx) return run(tx);
  const sql = await pg();
  return sql.begin(run);
}

/** A failed attempt (webhook `payment.failed`, demo failure). The appointment keeps waiting until its expiry. */
export async function markPaymentFailed(orderId: string, paymentId: string | null, reason: string | null, sql?: Queryable): Promise<string> {
  const db = sql ?? (await pg());
  const [row] = await db<{ r: { outcome: string } }[]>`select public.payment_mark_failed(${orderId}, ${paymentId}, ${reason}) as r`;
  return row.r.outcome;
}

export type RefundedResult = { payment_id: string; appointment_id: string; outcome: "refunded" | "already_refunded" | "ignored"; event_id: string | null };

/** Refund processed (refund job or `refund.processed` webhook) + the guardian's notification + strict audit, one transaction. */
export async function markPaymentRefunded(paymentId: string, refundId: string, tx?: Tx): Promise<RefundedResult> {
  const run = async (t: Tx): Promise<RefundedResult> => {
    const [row] = await t<{ r: Record<string, unknown> }[]>`select public.payment_mark_refunded(${paymentId}, ${refundId}) as r`;
    const r = row.r;
    const result: RefundedResult = {
      payment_id: String(r.payment_id),
      appointment_id: String(r.appointment_id),
      outcome: r.outcome as RefundedResult["outcome"],
      event_id: r.event_id === null || r.event_id === undefined ? null : String(r.event_id),
    };
    if (result.outcome === "refunded") {
      const scope = await appointmentScope(t, result.appointment_id);
      await auditStrict(
        {
          actor: "system",
          actorRole: "system",
          orgId: scope.org_id,
          childId: scope.child_id,
          action: "payment.refunded",
          entity: "payment",
          entityId: result.payment_id,
          details: { appointment_id: result.appointment_id },
        },
        t,
      );
    }
    return result;
  };
  if (tx) return run(tx);
  const sql = await pg();
  return sql.begin(run);
}

// ---------- webhook (FR-5) ----------

export type WebhookResult = {
  duplicate: boolean;
  outcome: string;
  /** Outbox events to deliver right away. */
  eventIds: string[];
  /** Payments that now wait for a refund (run the refund job right away). */
  refundPaymentIds: string[];
  /** 045: fee work to run right away (link refresh, fee refunds). */
  feeJobs?: boolean;
};

/**
 * Records the event (dedup by Razorpay's event id) and applies it, in ONE transaction: if processing fails nothing is
 * stored and Razorpay retries; a replay of a processed event is a no-op (`duplicate`). Unknown events are stored
 * with outcome `ignored`. Orders that are not ours (another app on the same account) -> `unknown_order`.
 */
export async function handleWebhookEvent(eventId: string, parsed: ParsedWebhook): Promise<WebhookResult> {
  const sql = await pg();
  return sql.begin(async (tx) => {
    const inserted = await tx<{ id: string }[]>`
      insert into public.payment_events (razorpay_event_id, event_type, payload)
      values (${eventId}, ${parsed.event.slice(0, 80)}, ${tx.json(parsed.stored as Parameters<typeof tx.json>[0])})
      on conflict (razorpay_event_id) do nothing
      returning id`;
    if (!inserted.length) return { duplicate: true, outcome: "duplicate", eventIds: [], refundPaymentIds: [] };

    let outcome = "ignored";
    let feeJobs = false;
    let paymentRowId: string | null = null;
    const eventIds: string[] = [];
    const refundPaymentIds: string[] = [];
    const p = parsed.payment;
    const orderRow = async (orderId: string | null) =>
      orderId ? (await tx<{ id: string }[]>`select id from public.payments where razorpay_order_id = ${orderId}`)[0] ?? null : null;

    if (parsed.event === "payment.captured" || parsed.event === "payment.authorized" || parsed.event === "payment.failed") {
      const own = p ? await orderRow(p.order_id) : null;
      if (!p || !own) {
        outcome = "unknown_order";
      } else {
        paymentRowId = own.id;
        if (parsed.event === "payment.captured") {
          const r = await applyPaymentCaptured({ orderId: p.order_id as string, paymentId: p.id, amountPaise: p.amount, actorUserId: null, source: "webhook" }, tx);
          outcome = r.outcome;
          if (r.event_id) eventIds.push(r.event_id);
          if (r.payment_status === "refund_pending") refundPaymentIds.push(r.payment_id);
        } else if (parsed.event === "payment.authorized") {
          const [row] = await tx<{ r: { outcome: string } }[]>`select public.payment_mark_authorized(${p.order_id}, ${p.id}) as r`;
          outcome = row.r.outcome;
        } else {
          outcome = await markPaymentFailed(p.order_id as string, p.id, p.error, tx);
        }
      }
    } else if (parsed.event === "payment_link.paid" || parsed.event === "payment_link.cancelled" || parsed.event === "payment_link.expired") {
      // 045: package and balance links.
      const link = parsed.paymentLink;
      const [own] = link ? await tx<{ id: string }[]>`select id from public.payments where razorpay_payment_link_id = ${link.id}` : [];
      if (!link || !own) {
        outcome = "unknown_link";
      } else {
        paymentRowId = own.id;
        if (parsed.event === "payment_link.paid") {
          if (!p) {
            outcome = "missing_payment";
          } else {
            const r = await applyLinkPaid(
              {
                linkId: link.id,
                paymentId: p.id,
                amountPaise: p.amount,
                capturedAt: p.created_at ? new Date(p.created_at * 1000) : null,
                source: "webhook",
              },
              tx,
            );
            outcome = r.outcome;
            feeJobs = true;
          }
        } else {
          outcome = await closeLink(link.id, parsed.event === "payment_link.expired" ? "link_expired" : "link_cancelled", tx);
        }
      }
    } else if (parsed.event === "transfer.processed" || parsed.event === "transfer.failed") {
      // 046: Route transfers to centres (by Razorpay's id, or our id from the notes if the API response is not in yet).
      const t = parsed.transfer;
      if (!t) {
        outcome = "unknown_transfer";
      } else {
        const [row] = await tx<{ r: { outcome: string; payment_id?: string; payout_item_id?: string; exhausted?: boolean; attempts?: number } }[]>`
          select public.payouts_apply_transfer_event(${parsed.event}, ${t.id}, ${t.payout_transfer}::uuid, ${t.error ?? "transfer_failed"},
                                                     ${TRANSFER_BACKOFF_SECONDS}::int[]) as r`;
        outcome = row.r.outcome;
        paymentRowId = row.r.payment_id ?? null;
        if (row.r.exhausted && row.r.payout_item_id) {
          eventIds.push(
            await enqueue(tx, {
              topic: "payouts.transfer_failed",
              aggregateType: "payout_item",
              aggregateId: row.r.payout_item_id,
              payload: { payout_item_id: row.r.payout_item_id },
              dedupKey: `payouts:transfer_failed:${row.r.payout_item_id}:${row.r.attempts ?? 0}`,
            }),
          );
        }
      }
    } else if (parsed.event === "refund.processed") {
      const refund = parsed.refund;
      // 045: partial refunds of link payments are fee refunds (one ledger row each).
      const [feeRefund] = refund ? await tx<{ id: string }[]>`select id from public.fee_refunds where razorpay_refund_id = ${refund.id}` : [];
      const [own] = refund
        ? await tx<{ id: string; purpose: string }[]>`select id, purpose from public.payments where razorpay_payment_id = ${refund.payment_id}`
        : [];
      if (refund && feeRefund) {
        paymentRowId = own?.id ?? null;
        const [row] = await tx<{ r: { outcome: string; event_id: string | null } }[]>`
          select public.fees_mark_refund_processed(${feeRefund.id}, ${refund.id}) as r`;
        outcome = `fee_refund_${row.r.outcome}`;
        if (row.r.event_id) eventIds.push(String(row.r.event_id));
      } else if (refund && own && own.purpose !== "appointment") {
        // A refund of a link payment we do not know yet (the job records it when it sees the refund id).
        paymentRowId = own.id;
        outcome = "fee_refund_pending";
        feeJobs = true;
      } else if (!refund || !own) {
        outcome = "unknown_payment";
      } else {
        paymentRowId = own.id;
        const r = await markPaymentRefunded(refund.payment_id, refund.id, tx);
        outcome = r.outcome;
        if (r.event_id) eventIds.push(r.event_id);
      }
    }

    await tx`update public.payment_events set processed_at = now(), outcome = ${outcome.slice(0, 80)}, payment_id = ${paymentRowId}
             where id = ${inserted[0].id}`;
    return { duplicate: false, outcome, eventIds, refundPaymentIds, feeJobs };
  });
}
