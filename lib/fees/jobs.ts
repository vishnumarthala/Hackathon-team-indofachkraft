// Ticket 045: fee jobs, run every minute by /api/cron/payments (with 031's refund job), by `npm run -s outbox:run` and
// right after a request through runFeeJobsSoon() (Next.js after()):
//   1. balance links to refresh (fee_link_requests, written by the billing hook, adjustments and link payments);
//   2. fee refunds (fee_refunds: partial refunds of link payments) - lease + back-off like 031, idempotent against
//      Razorpay (an existing refund with our receipt is reused), refund preconditions first (046 reverses transfers);
//   3. unpaid package offers expire after 7 days (link cancelled), active packages expire after their validity;
//   4. FR-8 reminders: one per unpaid session charge 3 days after the session, one per package when <= 2 sessions are
//      left or it expires within 7 days (outbox dedup keys make them one-off).
import { after } from "next/server";
import { errorMessage, logger } from "@/lib/log";
import { drainSoon, enqueue } from "@/lib/notify/outbox";
import { pg, type Sql } from "@/lib/pg";
import { getPaymentGateway, RazorpayApiError, type GatewayRefund, type PaymentGateway } from "@/lib/payments/razorpay";
import { refundBackoffSeconds, REFUND_LEASE_SECONDS, REFUND_POLL_SECONDS } from "@/lib/payments/jobs";
import { BALANCE_REMINDER_DAYS, PACKAGE_EXPIRY_WARNING_DAYS, PACKAGE_LOW_SESSIONS } from "./money";
import { closeLink, refreshBalanceLink, refundPreconditions, todayIst } from "./store";

const log = logger("fees.jobs");

export type FeeJobResult = {
  links: number;
  refunds: { processed: number; pending: number; failed: number };
  expired_offers: number;
  expired_packages: number;
  reminders: number;
};

type ClaimedRefund = {
  id: string;
  payment_id: string;
  razorpay_payment_id: string;
  amount_paise: number;
  razorpay_refund_id: string | null;
  attempts: number;
  appointment_id: string | null;
  child_package_id: string | null;
};

export function feeRefundReceipt(id: string): string {
  return `fr-${id.replace(/-/g, "")}`.slice(0, 40);
}

async function refundFor(gateway: PaymentGateway, row: ClaimedRefund): Promise<GatewayRefund> {
  if (row.razorpay_refund_id) return gateway.fetchRefund(row.razorpay_payment_id, row.razorpay_refund_id);
  const receipt = feeRefundReceipt(row.id);
  const existing = (await gateway.listRefunds(row.razorpay_payment_id)).find((r) => r.receipt === receipt && r.status !== "failed");
  if (existing) return existing;
  if (!gateway.createPartialRefund) throw new Error("payment gateway without partial refunds");
  return gateway.createPartialRefund(row.razorpay_payment_id, { amountPaise: row.amount_paise, receipt, notes: { fee_refund: row.id } });
}

export async function runFeeRefunds(sql: Sql, gateway: PaymentGateway | null, ids?: string[]): Promise<FeeJobResult["refunds"] & { eventIds: string[] }> {
  const result = { processed: 0, pending: 0, failed: 0, eventIds: [] as string[] };
  const claimed = await sql<ClaimedRefund[]>`
    update public.fee_refunds r
    set locked_until = now() + make_interval(secs => ${REFUND_LEASE_SECONDS}), attempts = r.attempts + 1
    from public.payments p
    where p.id = r.payment_id and r.id in (
      select id from public.fee_refunds
      where status = 'pending' and next_attempt_at <= now() and (locked_until is null or locked_until < now())
        and (${ids ?? null}::uuid[] is null or id = any(${ids ?? null}::uuid[]))
      order by next_attempt_at limit 20 for update skip locked)
    returning r.id, r.payment_id, p.razorpay_payment_id, r.amount_paise, r.razorpay_refund_id, r.attempts, r.appointment_id, r.child_package_id`;
  if (!claimed.length) return result;
  let gw: PaymentGateway;
  try {
    gw = gateway ?? getPaymentGateway();
  } catch (err) {
    log.error("fee refunds not possible: gateway not configured", { error: errorMessage(err) });
    await sql`update public.fee_refunds set locked_until = null, last_error = 'not_configured', next_attempt_at = now() + interval '5 minutes'
              where id in ${sql(claimed.map((c) => c.id))}`;
    result.failed += claimed.length;
    return result;
  }
  for (const row of claimed) {
    try {
      for (const hook of refundPreconditions()) {
        await hook({ id: row.id, payment_id: row.payment_id, amount_paise: row.amount_paise, appointment_id: row.appointment_id, child_package_id: row.child_package_id });
      }
      const refund = await refundFor(gw, row);
      if (refund.status === "processed") {
        const [done] = await sql<{ r: { event_id: string | null } }[]>`select public.fees_mark_refund_processed(${row.id}, ${refund.id}) as r`;
        if (done.r.event_id) result.eventIds.push(String(done.r.event_id));
        result.processed += 1;
      } else if (refund.status === "pending") {
        await sql`update public.fee_refunds set razorpay_refund_id = ${refund.id}, locked_until = null, last_error = null,
                  next_attempt_at = now() + make_interval(secs => ${REFUND_POLL_SECONDS})
                  where id = ${row.id} and attempts = ${row.attempts} and status = 'pending'`;
        result.pending += 1;
      } else {
        await sql`update public.fee_refunds set razorpay_refund_id = null, locked_until = null, last_error = 'refund_failed',
                  next_attempt_at = now() + make_interval(secs => ${refundBackoffSeconds(row.attempts)})
                  where id = ${row.id} and attempts = ${row.attempts} and status = 'pending'`;
        result.failed += 1;
      }
    } catch (err) {
      const code = err instanceof RazorpayApiError ? `${err.status} ${err.code}` : errorMessage(err);
      log.error("fee refund attempt failed", { refund: row.id, attempts: row.attempts, error: code });
      await sql`update public.fee_refunds set locked_until = null, last_error = ${code.slice(0, 500)},
                next_attempt_at = now() + make_interval(secs => ${refundBackoffSeconds(row.attempts)})
                where id = ${row.id} and attempts = ${row.attempts} and status = 'pending'`;
      result.failed += 1;
    }
  }
  return result;
}

async function expireOffers(sql: Sql, gateway: PaymentGateway | null): Promise<number> {
  const due = await sql<{ id: string; link_id: string | null }[]>`
    select cp.id, p.razorpay_payment_link_id as link_id
    from public.child_packages cp
    left join public.payments p on p.child_package_id = cp.id and p.status = 'created'
    where cp.status = 'pending_payment' and cp.offer_expires_at <= now()
    limit 50`;
  let n = 0;
  for (const row of due) {
    try {
      if (row.link_id) {
        const gw = gateway ?? getPaymentGateway();
        if ((await gw.cancelPaymentLink?.(row.link_id)) === "paid") continue;
        await closeLink(row.link_id, "offer_expired", sql);
      } else {
        await sql`update public.child_packages set status = 'cancelled', cancel_reason = 'offer_expired', updated_at = now()
                  where id = ${row.id} and status = 'pending_payment'`;
      }
      n += 1;
    } catch (err) {
      log.error("offer expiry failed", { child_package: row.id, error: errorMessage(err) });
    }
  }
  return n;
}

async function reminders(sql: Sql): Promise<{ count: number; eventIds: string[] }> {
  const eventIds: string[] = [];
  // Balance: the oldest open session charge of each account, once its session is 3 days old.
  const balances = await sql<{ org_id: string; child_id: string; ledger_id: string }[]>`
    with accounts as (select distinct org_id, child_id from public.family_ledger where kind = 'charge' and created_at > now() - interval '180 days')
    select ac.org_id, ac.child_id, o.ledger_id
    from accounts ac
    cross join lateral (
      select i.ledger_id from public.fees_open_items(ac.org_id, ac.child_id) i
      left join public.appointments a on a.id = i.appointment_id
      where i.kind = 'charge' and coalesce(lower(a.slot), i.created_at) <= now() - make_interval(days => ${BALANCE_REMINDER_DAYS})
      order by i.ledger_id limit 1) o
    where public.fees_balance(ac.org_id, ac.child_id) > 0`;
  for (const b of balances) {
    const id = await enqueue(sql, {
      topic: "fees.balance_reminder",
      aggregateType: "child",
      aggregateId: b.child_id,
      payload: { org_id: b.org_id, child_id: b.child_id },
      dedupKey: `fees:balance:${b.org_id}:${b.child_id}:${b.ledger_id}`,
    });
    eventIds.push(id);
  }
  const packages = await sql<{ id: string; child_id: string }[]>`
    select id, child_id from public.child_packages
    where status = 'active'
      and (sessions_total - sessions_used <= ${PACKAGE_LOW_SESSIONS}
           or expires_on <= ${todayIst()}::date + ${PACKAGE_EXPIRY_WARNING_DAYS}::int)`;
  for (const p of packages) {
    const id = await enqueue(sql, {
      topic: "fees.package_reminder",
      aggregateType: "child_package",
      aggregateId: p.id,
      payload: { child_package_id: p.id, child_id: p.child_id },
      dedupKey: `fees:package:${p.id}:ending`,
    });
    eventIds.push(id);
  }
  return { count: balances.length + packages.length, eventIds };
}

export async function runFeeJobs(opts: { sql?: Sql; gateway?: PaymentGateway; refundIds?: string[] } = {}): Promise<FeeJobResult> {
  const sql = opts.sql ?? (await pg());
  const gateway = opts.gateway ?? null;
  const result: FeeJobResult = { links: 0, refunds: { processed: 0, pending: 0, failed: 0 }, expired_offers: 0, expired_packages: 0, reminders: 0 };
  const eventIds: string[] = [];

  result.expired_offers = await expireOffers(sql, gateway);
  const expired = await sql`
    update public.child_packages set status = 'expired', updated_at = now()
    where status = 'active' and expires_on < ${todayIst()}::date returning id`;
  result.expired_packages = expired.length;

  // Balance links that expire within a day are renewed.
  await sql`
    insert into public.fee_link_requests (org_id, child_id)
    select org_id, child_id from public.payments
    where purpose = 'balance' and status = 'created' and link_expires_at < now() + interval '1 day' and child_id is not null
    on conflict do nothing`;
  const requests = await sql<{ org_id: string; child_id: string }[]>`
    select org_id, child_id from public.fee_link_requests order by requested_at limit 20`;
  for (const r of requests) {
    try {
      const out = await refreshBalanceLink(r.org_id, r.child_id, { gateway: opts.gateway });
      if (out.changed) result.links += 1;
    } catch (err) {
      log.error("balance link refresh failed", { error: errorMessage(err) });
    }
  }

  const refunds = await runFeeRefunds(sql, gateway, opts.refundIds);
  result.refunds = { processed: refunds.processed, pending: refunds.pending, failed: refunds.failed };
  eventIds.push(...refunds.eventIds);

  const rem = await reminders(sql);
  result.reminders = rem.count;
  eventIds.push(...rem.eventIds);
  if (eventIds.length) drainSoon(eventIds);
  return result;
}

/** Runs the fee jobs right after the current response (no-op outside a request; the cron picks the work up). */
export function runFeeJobsSoon(): void {
  try {
    after(async () => {
      try {
        await runFeeJobs();
      } catch (err) {
        log.error("immediate fee run failed", { error: errorMessage(err) });
      }
    });
  } catch {
    // Not inside a request scope.
  }
}
