// Ticket 046: the payout jobs.
//   runPayoutJobs (every minute with /api/cron/payments, `npm run -s outbox:run`, and right after attendance marking,
//   captures and webhooks through runFeeJobsSoon):
//     1. payouts_sync: one payout item per billable, funded consultation (FR-3, NFR-1); corrections void or reverse;
//     2. expired packages: unused sessions paid out (`pay_centre`) or refunded (`refund_family`) (FR-6);
//     3. reversals that were requested (corrections, refunds) (FR-5);
//     4. Route transfers: claimed under a lease with the untransferred amount checked in SQL (NFR-3); our transfer id is
//        the idempotency key (looked up at Razorpay before a retry creates anything); failures retry with back-off 3
//        times, then admins are alerted and see them in /admin/payouts (FR-3, FR-9);
//     5. held transfers released once the account is active again.
//   runDailyPayoutJobs (/api/cron/payouts, daily 01:00 IST): reconciliation (FR-10) and the monthly platform-fee tax
//   invoices for the previous month (FR-7; idempotent, so the 1st's run issues them and later runs find them).
import { after } from "next/server";
import { audit } from "@/lib/audit";
import { errorMessage, logger } from "@/lib/log";
import { drainSoon, enqueue } from "@/lib/notify/outbox";
import { pg, type Queryable, type Sql } from "@/lib/pg";
import { getPaymentGateway, RazorpayApiError, type GatewayTransfer, type PaymentGateway } from "@/lib/payments/razorpay";
import { payoutConfig } from "./config";
import { demoTransferEventBody, demoTransferOutcome, deliverDemoWebhook } from "./demo";
import { previousMonthIst, reconDiff, TRANSFER_BACKOFF_SECONDS, TRANSFER_LEASE_SECONDS } from "./fees";
import { runReversals, type ReversalResult } from "./reversals";

const log = logger("payouts.jobs");

export type TransferResult = { transferred: number; failed: number; skipped: number };
export type PayoutJobResult = {
  sync: { created: number; reopened: number; voided: number; reverse_requested: number };
  expiry: { settled: number; items: number; refunds: number };
  reversals: ReversalResult;
  transfers: TransferResult;
  released: number;
};

type Claimed = {
  payout_item_id: string;
  transfer_id: string;
  org_id: string;
  payment_id: string;
  razorpay_payment_id: string;
  account_id: string;
  amount_paise: number;
  on_hold: boolean;
  attempts: number;
};

/** Admins hear about a transfer whose retries are used up (once per run of retries). */
export async function alertTransferFailed(sql: Queryable, itemId: string, attempts: number): Promise<string> {
  return enqueue(sql, {
    topic: "payouts.transfer_failed",
    aggregateType: "payout_item",
    aggregateId: itemId,
    payload: { payout_item_id: itemId },
    dedupKey: `payouts:transfer_failed:${itemId}:${attempts}`,
  });
}

async function attemptFailed(sql: Queryable, row: Claimed, definitive: boolean, reason: string, events: string[]): Promise<void> {
  const [res] = await sql<{ r: { outcome: string; exhausted?: boolean; attempts?: number } }[]>`
    select public.payouts_attempt_failed(${row.payout_item_id}, ${row.transfer_id}, ${definitive}, ${reason.slice(0, 300)},
                                         ${TRANSFER_BACKOFF_SECONDS}::int[]) as r`;
  if (res.r.exhausted) events.push(await alertTransferFailed(sql, row.payout_item_id, res.r.attempts ?? row.attempts));
}

export async function runTransfers(
  sql: Sql,
  gateway: PaymentGateway | null,
  opts: { itemId?: string; limit?: number; demoWebhooks?: string[]; orgIds?: string[] } = {},
): Promise<TransferResult & { eventIds: string[] }> {
  const result = { transferred: 0, failed: 0, skipped: 0, eventIds: [] as string[] };
  const { demo } = payoutConfig();
  let gw: PaymentGateway;
  try {
    gw = gateway ?? getPaymentGateway();
  } catch (err) {
    log.error("transfers not possible: gateway not configured", { error: errorMessage(err) });
    return result;
  }
  if (!gw.createTransfer) return result;
  const claimed = await sql<Claimed[]>`
    select * from public.payouts_claim_transfers(${opts.limit ?? 50}, ${opts.itemId ?? null}::uuid, ${demo}, ${TRANSFER_LEASE_SECONDS},
                                                 ${opts.orgIds ?? null}::uuid[])`;
  for (const row of claimed) {
    try {
      let transfer: GatewayTransfer | undefined;
      if (row.attempts > 1 && gw.listTransfers) {
        // A retry: the earlier attempt may have reached Razorpay (look it up by our idempotency key).
        transfer = (await gw.listTransfers(row.razorpay_payment_id)).find((t) => t.payout_transfer === row.transfer_id && t.status !== "failed");
      }
      transfer ??= await gw.createTransfer({
        paymentId: row.razorpay_payment_id,
        account: row.account_id,
        amountPaise: row.amount_paise,
        onHold: row.on_hold,
        idempotencyKey: row.transfer_id,
        notes: { payout_item: row.payout_item_id },
      });
      if (transfer.status === "failed") {
        await attemptFailed(sql, row, true, "transfer_failed", result.eventIds);
        result.failed += 1;
        continue;
      }
      if (transfer.amount && transfer.amount !== row.amount_paise) throw new Error("transfer amount mismatch");
      await sql`select public.payouts_record_transfer(${row.transfer_id}, ${transfer.id}, ${transfer.status === "processed"})`;
      result.transferred += 1;
      if (gw.kind === "demo") {
        opts.demoWebhooks?.push(
          demoTransferEventBody(demoTransferOutcome(row.account_id), {
            transferId: transfer.id,
            source: row.razorpay_payment_id,
            recipient: row.account_id,
            amountPaise: row.amount_paise,
            onHold: row.on_hold,
            payoutTransfer: row.transfer_id,
          }),
        );
      }
    } catch (err) {
      const definitive = err instanceof RazorpayApiError && !err.retryable;
      const code = err instanceof RazorpayApiError ? `${err.status} ${err.code}` : errorMessage(err);
      log.error("transfer attempt failed", { item: row.payout_item_id, attempts: row.attempts, error: code });
      await attemptFailed(sql, row, definitive, code, result.eventIds);
      result.failed += 1;
    }
  }
  return result;
}

async function runReleases(sql: Sql, gateway: PaymentGateway | null, orgIds?: string[]): Promise<number> {
  const { demo } = payoutConfig();
  const rows = await sql<{ payout_item_id: string; transfer_id: string; razorpay_transfer_id: string }[]>`
    select * from public.payouts_claim_releases(20, ${demo}, ${orgIds ?? null}::uuid[])`;
  if (!rows.length) return 0;
  let n = 0;
  for (const row of rows) {
    try {
      const gw = gateway ?? getPaymentGateway();
      if (!gw.releaseTransfer) throw new Error("payment gateway without Route releases");
      await gw.releaseTransfer(row.razorpay_transfer_id);
      await sql`select public.payouts_record_release(${row.transfer_id})`;
      n += 1;
    } catch (err) {
      log.error("release failed", { item: row.payout_item_id, error: errorMessage(err) });
      await sql`update public.payout_items set locked_until = null where id = ${row.payout_item_id}`;
    }
  }
  return n;
}

/** `orgIds` limits a run to some organisations (targeted runs and tests); default: all. */
export async function runPayoutJobs(opts: { sql?: Sql; gateway?: PaymentGateway; itemId?: string; orgIds?: string[] } = {}): Promise<PayoutJobResult> {
  const sql = opts.sql ?? (await pg());
  const { defaultFeeBps, gstBps } = payoutConfig();
  const gateway = opts.gateway ?? null;
  const orgs = opts.orgIds ?? null;
  const [sync] = await sql<{ r: PayoutJobResult["sync"] }[]>`
    select public.payouts_sync(${defaultFeeBps}, ${gstBps}, null, ${orgs}::uuid[]) as r`;
  const [expiry] = await sql<{ r: PayoutJobResult["expiry"] }[]>`
    select public.payouts_settle_package_expiry(${defaultFeeBps}, ${gstBps}, 50, ${orgs}::uuid[]) as r`;
  const reversals = await runReversals(sql, gateway, { orgIds: opts.orgIds });
  const demoWebhooks: string[] = [];
  const transfers = await runTransfers(sql, gateway, { itemId: opts.itemId, demoWebhooks, orgIds: opts.orgIds });
  const released = await runReleases(sql, gateway, opts.orgIds);
  const eventIds = [...transfers.eventIds];
  // DEMO_MODE: Razorpay's transfer webhooks, faked and delivered through the signed webhook handler.
  for (const body of demoWebhooks) {
    try {
      const r = await deliverDemoWebhook(body);
      eventIds.push(...r.eventIds);
    } catch (err) {
      log.error("demo transfer webhook failed", { error: errorMessage(err) });
    }
  }
  if (eventIds.length) drainSoon(eventIds);
  if (expiry.r.refunds > 0) {
    // FR-6 refund_family: the fee refund job sends them (045 refund path).
    const { runFeeRefunds } = await import("@/lib/fees/jobs");
    await runFeeRefunds(sql, opts.gateway ?? null).catch((err) => log.error("expiry refunds failed", { error: errorMessage(err) }));
  }
  return {
    sync: sync.r,
    expiry: expiry.r,
    reversals,
    transfers: { transferred: transfers.transferred, failed: transfers.failed, skipped: transfers.skipped },
    released,
  };
}

/** Runs the payout jobs right after the current response (no-op outside a request; the cron picks the work up). */
export function runPayoutJobsSoon(): void {
  try {
    after(async () => {
      try {
        await runPayoutJobs();
      } catch (err) {
        log.error("immediate payout run failed", { error: errorMessage(err) });
      }
    });
  } catch {
    // Not inside a request scope.
  }
}

// ---------- daily: reconciliation (FR-10) and monthly invoices (FR-7) ----------

export type ReconFlag = { payment_id: string; org_id: string | null; diff_paise: number };
export type DailyResult = { reconciliation: { checked: number; flagged: number; new_flags: number; resolved: number }; invoices: { issued: string[]; month: string } };

export async function runReconciliation(sql: Sql, opts: { orgId?: string; now?: Date } = {}): Promise<DailyResult["reconciliation"] & { flags: ReconFlag[] }> {
  const rows = await sql<{
    payment_id: string;
    org_id: string | null;
    captured_paise: number;
    transferred_paise: string;
    platform_share_paise: string;
    refunded_paise: string;
    settled: boolean;
  }[]>`select * from public.payouts_reconciliation(${opts.orgId ?? null}::uuid, null)`;
  const flags: ReconFlag[] = [];
  let newFlags = 0;
  const balanced: string[] = [];
  for (const r of rows) {
    if (!r.settled) continue;
    const row = {
      captured_paise: Number(r.captured_paise),
      transferred_paise: Number(r.transferred_paise),
      platform_share_paise: Number(r.platform_share_paise),
      refunded_paise: Number(r.refunded_paise),
    };
    const diff = reconDiff(row);
    if (diff === 0) {
      balanced.push(r.payment_id);
      continue;
    }
    flags.push({ payment_id: r.payment_id, org_id: r.org_id, diff_paise: diff });
    const inserted = await sql`
      insert into public.payout_reconciliation_flags (payment_id, org_id, captured_paise, transferred_paise, platform_share_paise, refunded_paise, diff_paise)
      values (${r.payment_id}, ${r.org_id}, ${row.captured_paise}, ${row.transferred_paise}, ${row.platform_share_paise}, ${row.refunded_paise}, ${diff})
      on conflict (payment_id) where resolved_at is null do update set last_seen_at = now(), diff_paise = excluded.diff_paise,
        transferred_paise = excluded.transferred_paise, platform_share_paise = excluded.platform_share_paise,
        refunded_paise = excluded.refunded_paise
      returning (xmax = 0) as fresh`;
    if (inserted[0]?.fresh) newFlags += 1;
  }
  let resolved = 0;
  if (balanced.length) {
    const r = await sql`update public.payout_reconciliation_flags set resolved_at = now()
                        where resolved_at is null and payment_id in ${sql(balanced)} returning id`;
    resolved = r.length;
  }
  if (newFlags > 0) {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(opts.now ?? new Date());
    const id = await enqueue(sql, {
      topic: "payouts.reconciliation_alert",
      aggregateType: "payout_reconciliation",
      aggregateId: today,
      payload: { date: today, count: newFlags },
      dedupKey: `payouts:reconciliation:${today}`,
    });
    drainSoon([id]);
  }
  return { checked: rows.length, flagged: flags.length, new_flags: newFlags, resolved, flags };
}

/** FR-7: issues last month's platform-fee invoice for every organisation with fees (idempotent per org and month). */
export async function issueMonthlyInvoices(sql: Sql, opts: { now?: Date; orgId?: string } = {}): Promise<DailyResult["invoices"]> {
  const now = opts.now ?? new Date();
  const month = previousMonthIst(now);
  const { platform } = payoutConfig();
  const orgs = await sql<{ id: string; name: string; legal_name: string | null; gstin: string | null }[]>`
    select o.id, o.name, a.legal_name, a.gstin
    from public.organizations o left join public.org_payout_accounts a on a.org_id = o.id
    where exists (select 1 from public.payout_items i where i.org_id = o.id and i.invoice_id is null and i.status <> 'reversed'
                  and i.fee_paise > 0 and i.consultation_on < (${month}::date + interval '1 month')::date)
      and (${opts.orgId ?? null}::uuid is null or o.id = ${opts.orgId ?? null}::uuid)`;
  const issued: string[] = [];
  for (const o of orgs) {
    try {
      const [row] = await sql<{ r: { outcome: string; invoice_no?: string; invoice_id?: string } }[]>`
        select public.payouts_issue_invoice(${o.id}, ${month}::date, ${now}, ${sql.json({ name: o.name, legal_name: o.legal_name, gstin: o.gstin })},
                                            ${sql.json(platform)}) as r`;
      if (row.r.outcome === "issued" && row.r.invoice_no) {
        issued.push(row.r.invoice_no);
        await audit({
          actor: "system",
          actorRole: "system",
          orgId: o.id,
          action: "payouts.invoice_issued",
          entity: "platform_invoice",
          entityId: row.r.invoice_id,
          details: { invoice_no: row.r.invoice_no, month },
        });
      }
    } catch (err) {
      log.error("invoice failed", { org: o.id, error: errorMessage(err) });
    }
  }
  if (issued.length) drainSoon();
  return { issued, month };
}

export async function runDailyPayoutJobs(opts: { sql?: Sql; now?: Date } = {}): Promise<DailyResult> {
  const sql = opts.sql ?? (await pg());
  const reconciliation = await runReconciliation(sql, { now: opts.now });
  const invoices = await issueMonthlyInvoices(sql, { now: opts.now });
  return {
    reconciliation: { checked: reconciliation.checked, flagged: reconciliation.flagged, new_flags: reconciliation.new_flags, resolved: reconciliation.resolved },
    invoices,
  };
}
