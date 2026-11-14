// Ticket 045: packages, the family account (append-only ledger), payment links, refunds and adjustments. Server-only
// (shared Postgres pool, lib/pg.ts). Callers gate first (lib/fees/authz.ts); money-changing actions write a strict audit
// row in the same transaction (041). The SQL side (billing hook, link capture, receipts) is in
// supabase/migrations/20261113004500_packages_family_payments.sql.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { auditStrict, type SessionAuditActor } from "@/lib/audit";
import { env } from "@/lib/env";
import { enqueue } from "@/lib/notify/outbox";
import { pg, type Queryable, type Tx } from "@/lib/pg";
import { getPaymentGateway, type GatewayPaymentLink, type PaymentGateway } from "@/lib/payments/razorpay";
import { balanceOverdue, packageEnding, PACKAGE_OFFER_DAYS, packageRefundPaise, type LedgerKind } from "./money";
import { payoutReadiness } from "@/lib/payouts/store";

if (typeof window !== "undefined") {
  throw new Error("lib/fees/store.ts is server-only");
}

type Actor = SessionAuditActor & { actorUserId: string };

// ---------- errors ----------

export const FEES_ERRORS = {
  package_not_found: { status: 404, error: "Package not found" },
  package_inactive: { status: 409, error: "This package is no longer offered." },
  services_invalid: { status: 400, error: "Choose services of this organisation." },
  offer_pending: { status: 409, error: "This child already has an unpaid offer for this package." },
  nothing_due: { status: 409, error: "There is nothing to pay right now." },
  nothing_to_refund: { status: 409, error: "There is nothing left to refund." },
  not_refundable: { status: 409, error: "This cannot be refunded here." },
  not_paid: { status: 409, error: "This session has not been paid yet. Use an adjustment instead." },
  link_too_large: { status: 409, error: "The amount is too large for one payment link." },
  not_configured: { status: 503, error: "Online payment is not available right now. Please try again later." },
  gateway_error: { status: 502, error: "The payment link could not be created. Please try again." },
  // 046 FR-2 / FR-8: packages need an active payout account and the accepted platform fee.
  payout_account_inactive: { status: 409, error: "Finish payout setup to accept payments." },
  fee_policy_not_accepted: { status: 409, error: "Accept the platform fee on the Payouts page before taking payments." },
} as const;
export type FeesErrorCode = keyof typeof FEES_ERRORS;

export class FeesError extends Error {
  constructor(readonly code: FeesErrorCode) {
    super(code);
    this.name = "FeesError";
  }
}

export function feesErrorResponse(code: FeesErrorCode): Response {
  const { status, error } = FEES_ERRORS[code];
  return Response.json({ error, code }, { status });
}

// ---------- schemas ----------

export const PackageInputSchema = z.object({
  name: z.string().trim().min(1, { error: "Give the package a name" }).max(80),
  session_count: z.number().int().min(1, { error: "1 to 60 sessions" }).max(60, { error: "1 to 60 sessions" }),
  price_inr: z.number().int().min(1, { error: "Enter a price" }).max(100000),
  validity_days: z.number().int().min(7, { error: "7 to 180 days" }).max(180, { error: "7 to 180 days" }),
  service_ids: z.array(z.uuid()).min(1, { error: "Choose at least one service" }).max(50),
  active: z.boolean().default(true),
});
export const PackageUpdateSchema = PackageInputSchema.partial().refine((v) => Object.keys(v).length > 0, { message: "Nothing to update" });
export const OfferSchema = z.object({ package_id: z.uuid() });
export const AdjustmentSchema = z.object({
  /** Rupees: positive = the family owes more, negative = credit. */
  amount_inr: z.number().int().refine((n) => n !== 0, { error: "Enter an amount" }).refine((n) => Math.abs(n) <= 100000, { error: "Up to ₹1,00,000" }),
  reason: z.string().trim().min(3, { error: "Give a reason" }).max(300),
});
export const RefundSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("package"), child_package_id: z.uuid(), reason: z.string().trim().min(3, { error: "Give a reason" }).max(300) }),
  z.object({ kind: z.literal("session"), appointment_id: z.uuid(), reason: z.string().trim().min(3, { error: "Give a reason" }).max(300) }),
]);

// ---------- rows ----------

export type PackageRow = {
  id: string;
  org_id: string;
  name: string;
  session_count: number;
  price_inr: number;
  validity_days: number;
  service_ids: string[];
  active: boolean;
};

export type ChildPackageStatus = "pending_payment" | "active" | "used_up" | "expired" | "cancelled";
export type ChildPackageRow = {
  id: string;
  org_id: string;
  child_id: string;
  name: string;
  sessions_total: number;
  sessions_used: number;
  price_paise: number;
  status: ChildPackageStatus;
  starts_on: string | null;
  expires_on: string | null;
  offer_expires_at: string;
  payment_id: string | null;
  link_url: string | null;
  receipt_no: string | null;
  created_at: string;
};

export type LedgerRow = {
  id: string;
  kind: LedgerKind;
  amount_paise: number;
  note: string;
  appointment_id: string | null;
  child_package_id: string | null;
  payment_id: string | null;
  receipt_no: string | null;
  created_at: string;
  /** Session start (appointment rows) for display. */
  session_at: string | null;
  package_name: string | null;
  manual: boolean;
};

export type OpenLink = { payment_id: string; purpose: "package" | "balance"; url: string; amount_paise: number; expires_at: string | null };

export type Account = {
  org: { id: string; name: string };
  child_id: string;
  balance_paise: number;
  /** The open balance link (pay the balance). */
  balance_link: OpenLink | null;
  packages: ChildPackageRow[];
  ledger: LedgerRow[];
  pending_refunds: { id: string; amount_paise: number; reason: string; created_at: string }[];
  oldest_unpaid_at: string | null;
  overdue: boolean;
  package_ending: boolean;
};

const iso = (v: unknown): string | null => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : String(v));
const day = (v: unknown): string | null => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

export function todayIst(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

function toPackage(r: Record<string, unknown>): PackageRow {
  return {
    id: String(r.id),
    org_id: String(r.org_id),
    name: String(r.name),
    session_count: Number(r.session_count),
    price_inr: Number(r.price_inr),
    validity_days: Number(r.validity_days),
    service_ids: (r.service_ids as string[]) ?? [],
    active: Boolean(r.active),
  };
}

function toChildPackage(r: Record<string, unknown>): ChildPackageRow {
  return {
    id: String(r.id),
    org_id: String(r.org_id),
    child_id: String(r.child_id),
    name: String((r.snapshot as { name?: string } | null)?.name ?? ""),
    sessions_total: Number(r.sessions_total),
    sessions_used: Number(r.sessions_used),
    price_paise: Number(r.price_paise),
    status: r.status as ChildPackageStatus,
    starts_on: day(r.starts_on),
    expires_on: day(r.expires_on),
    offer_expires_at: iso(r.offer_expires_at) as string,
    payment_id: (r.payment_id as string | null) ?? null,
    link_url: (r.link_url as string | null) ?? null,
    receipt_no: (r.receipt_no as string | null) ?? null,
    created_at: iso(r.created_at) as string,
  };
}

const CHILD_PACKAGE_SELECT = `
  select cp.id, cp.org_id, cp.child_id, cp.snapshot, cp.sessions_total, cp.sessions_used, cp.price_paise, cp.status,
         cp.starts_on, cp.expires_on, cp.offer_expires_at, cp.created_at,
         coalesce(cp.payment_id, lp.id) as payment_id,
         case when lp.status = 'created' then lp.payment_link_url end as link_url,
         coalesce(pp.receipt_no, lp.receipt_no) as receipt_no
  from public.child_packages cp
  left join public.payments pp on pp.id = cp.payment_id
  left join lateral (select p.id, p.status, p.payment_link_url, p.receipt_no from public.payments p
                     where p.child_package_id = cp.id order by p.created_at desc limit 1) lp on true`;

// ---------- packages (org settings, FR-7) ----------

export async function listPackages(orgId: string, opts: { activeOnly?: boolean } = {}): Promise<PackageRow[]> {
  const sql = await pg();
  const rows = await sql`
    select id, org_id, name, session_count, price_inr, validity_days, service_ids, active from public.packages
    where org_id = ${orgId} and (${!opts.activeOnly} or active) order by active desc, name`;
  return rows.map(toPackage);
}

/** 046 FR-2 / FR-8: offering packages needs an active payout account and the accepted platform fee. */
async function assertPayoutReady(orgId: string, tx: Queryable): Promise<void> {
  const r = await payoutReadiness(orgId, tx);
  if (r.block) throw new FeesError(r.block);
}

async function assertOrgServices(tx: Queryable, orgId: string, serviceIds: string[]): Promise<void> {
  const [row] = await tx<{ n: number }[]>`
    select count(distinct id)::int as n from public.services where org_id = ${orgId} and id = any(${serviceIds}::uuid[])`;
  if (row.n !== new Set(serviceIds).size) throw new FeesError("services_invalid");
}

/** Owner/admin: a new package in the organisation's catalogue (strict audit). */
export async function createPackage(orgId: string, input: z.output<typeof PackageInputSchema>, actor: Actor): Promise<PackageRow> {
  const sql = await pg();
  return sql.begin(async (tx) => {
    if (input.active) await assertPayoutReady(orgId, tx);
    await assertOrgServices(tx, orgId, input.service_ids);
    const [row] = await tx`
      insert into public.packages (org_id, name, session_count, price_inr, validity_days, service_ids, active, created_by)
      values (${orgId}, ${input.name}, ${input.session_count}, ${input.price_inr}, ${input.validity_days},
              ${input.service_ids}::uuid[], ${input.active}, ${actor.actorUserId})
      returning id, org_id, name, session_count, price_inr, validity_days, service_ids, active`;
    const pkg = toPackage(row);
    await auditStrict(
      { ...actor, orgId, action: "fees.packages_changed", entity: "package", entityId: pkg.id, details: { change: "created", session_count: pkg.session_count, price_inr: pkg.price_inr, validity_days: pkg.validity_days } },
      tx,
    );
    return pkg;
  }) as Promise<PackageRow>;
}

/** Owner/admin: edit a package. Offers already made keep their snapshot. */
export async function updatePackage(orgId: string, packageId: string, input: z.output<typeof PackageUpdateSchema>, actor: Actor): Promise<PackageRow> {
  const sql = await pg();
  return sql.begin(async (tx) => {
    const [current] = await tx`select * from public.packages where id = ${packageId} and org_id = ${orgId} for update`;
    if (!current) throw new FeesError("package_not_found");
    const next = { ...toPackage(current), ...input };
    if (next.active && !current.active) await assertPayoutReady(orgId, tx);
    if (input.service_ids) await assertOrgServices(tx, orgId, input.service_ids);
    const [row] = await tx`
      update public.packages set name = ${next.name}, session_count = ${next.session_count}, price_inr = ${next.price_inr},
        validity_days = ${next.validity_days}, service_ids = ${next.service_ids}::uuid[], active = ${next.active}, updated_at = now()
      where id = ${packageId}
      returning id, org_id, name, session_count, price_inr, validity_days, service_ids, active`;
    const pkg = toPackage(row);
    await auditStrict(
      { ...actor, orgId, action: "fees.packages_changed", entity: "package", entityId: pkg.id, details: { change: "updated", fields: Object.keys(input), active: pkg.active } },
      tx,
    );
    return pkg;
  }) as Promise<PackageRow>;
}

// ---------- payment links ----------

function gatewayWithLinks(gateway?: PaymentGateway): Required<Pick<PaymentGateway, "createPaymentLink" | "cancelPaymentLink">> & PaymentGateway {
  const gw = gateway ?? getPaymentGateway();
  if (!gw.createPaymentLink || !gw.cancelPaymentLink) throw new Error("payment gateway without payment links");
  return gw as Required<Pick<PaymentGateway, "createPaymentLink" | "cancelPaymentLink">> & PaymentGateway;
}

export function linkCallbackUrl(): string {
  return `${env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "")}/api/payments/links/callback`;
}

const MAX_LINK_PAISE = 10_000_000;

async function createLinkRow(
  tx: Tx,
  gateway: ReturnType<typeof gatewayWithLinks>,
  input: {
    purpose: "package" | "balance";
    orgId: string;
    orgName: string;
    childId: string;
    childPackageId?: string | null;
    amountPaise: number;
    description: string;
    expiresAt: Date;
    createdBy: string | null;
  },
): Promise<{ paymentId: string; link: GatewayPaymentLink }> {
  if (input.amountPaise > MAX_LINK_PAISE) throw new FeesError("link_too_large");
  const paymentId = randomUUID();
  let link: GatewayPaymentLink;
  try {
    link = await gateway.createPaymentLink({
      amountPaise: input.amountPaise,
      referenceId: paymentId.replace(/-/g, ""),
      // NFR-3: what is paid for and to whom, never the child.
      description: `${input.description} - paid to DoctorNearMe on behalf of ${input.orgName}`.slice(0, 250),
      expireBy: input.expiresAt,
      callbackUrl: linkCallbackUrl(),
      notes: { payment: paymentId, purpose: input.purpose },
    });
  } catch {
    throw new FeesError("gateway_error");
  }
  if (link.amount !== input.amountPaise) throw new Error("razorpay link amount mismatch");
  await tx`
    insert into public.payments (id, purpose, org_id, child_id, child_package_id, gateway, razorpay_payment_link_id, payment_link_url,
                                 link_expires_at, amount_paise, currency, status, created_by)
    values (${paymentId}, ${input.purpose}, ${input.orgId}, ${input.childId}, ${input.childPackageId ?? null}, ${gateway.kind},
            ${link.id}, ${link.short_url}, ${input.expiresAt}, ${input.amountPaise}, 'INR', 'created', ${input.createdBy})`;
  return { paymentId, link };
}

const BALANCE_LINK_DAYS = 30;

export type RefreshResult = { payment_id: string | null; amount_paise: number; changed: boolean; replaced: string | null };

/**
 * FR-4: the account's balance link always covers exactly the open items (session charges and manual adjustments that
 * are neither paid nor cancelled). An open link that covers something else is cancelled at Razorpay and replaced
 * (a link's amount cannot change). Nothing open -> no link. Serialised per account.
 */
export async function refreshBalanceLink(
  orgId: string,
  childId: string,
  opts: { gateway?: PaymentGateway; actorUserId?: string | null; tx?: Tx } = {},
): Promise<RefreshResult> {
  const run = async (tx: Tx): Promise<RefreshResult> => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${`fees-account:${orgId}:${childId}`}, 0))`;
    await tx`delete from public.fee_link_requests where org_id = ${orgId} and child_id = ${childId}`;
    const items = await tx<{ ledger_id: string; amount_paise: number }[]>`
      select ledger_id, amount_paise from public.fees_open_items(${orgId}, ${childId})`;
    const total = items.reduce((s, i) => s + i.amount_paise, 0);
    const [open] = await tx<{ id: string; razorpay_payment_link_id: string; amount_paise: number; link_expires_at: Date | null }[]>`
      select id, razorpay_payment_link_id, amount_paise, link_expires_at from public.payments
      where org_id = ${orgId} and child_id = ${childId} and purpose = 'balance' and status = 'created'
      order by created_at desc limit 1 for update`;
    if (open) {
      const covered = await tx<{ ledger_id: string }[]>`select ledger_id from public.fee_link_items where payment_id = ${open.id}`;
      const same =
        covered.length === items.length &&
        covered.every((c) => items.some((i) => String(i.ledger_id) === String(c.ledger_id))) &&
        open.amount_paise === total &&
        (!open.link_expires_at || open.link_expires_at.getTime() > Date.now() + 86_400_000);
      if (same) return { payment_id: open.id, amount_paise: total, changed: false, replaced: null };
    }
    const gateway = gatewayWithLinks(opts.gateway);
    let replaced: string | null = null;
    if (open) {
      const outcome = await gateway.cancelPaymentLink(open.razorpay_payment_link_id);
      // Paid meanwhile: the payment_link.paid webhook records it and asks for a new refresh.
      if (outcome === "paid") return { payment_id: open.id, amount_paise: open.amount_paise, changed: false, replaced: null };
      await tx`select public.fees_close_link(${open.razorpay_payment_link_id}, 'link_replaced')`;
      replaced = open.id;
    }
    if (total < 100) return { payment_id: null, amount_paise: total, changed: replaced !== null, replaced };
    const [org] = await tx<{ name: string }[]>`select name from public.organizations where id = ${orgId}`;
    const { paymentId } = await createLinkRow(tx, gateway, {
      purpose: "balance",
      orgId,
      orgName: org?.name ?? "the centre",
      childId,
      amountPaise: total,
      description: "Sessions",
      expiresAt: new Date(Date.now() + BALANCE_LINK_DAYS * 86_400_000),
      createdBy: opts.actorUserId ?? null,
    });
    for (const item of items) {
      await tx`insert into public.fee_link_items (payment_id, ledger_id, amount_paise) values (${paymentId}, ${item.ledger_id}, ${item.amount_paise})`;
    }
    return { payment_id: paymentId, amount_paise: total, changed: true, replaced };
  };
  if (opts.tx) return run(opts.tx);
  const sql = await pg();
  return sql.begin(run) as Promise<RefreshResult>;
}

// ---------- FR-3: offer a package ----------

export type OfferResult = { child_package_id: string; payment_id: string; url: string; amount_paise: number };

/** Owner/admin `Offer package`: a pending child package + a payment link, sent to the guardian (in-app + WhatsApp). */
export async function offerPackage(
  scope: { orgId: string; childId: string; caseId: string; orgName: string },
  packageId: string,
  actor: Actor,
  deps: { gateway?: PaymentGateway } = {},
): Promise<OfferResult> {
  const gateway = gatewayWithLinks(deps.gateway);
  const sql = await pg();
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${`fees-account:${scope.orgId}:${scope.childId}`}, 0))`;
    const [pkgRow] = await tx`select * from public.packages where id = ${packageId} and org_id = ${scope.orgId}`;
    if (!pkgRow) throw new FeesError("package_not_found");
    const pkg = toPackage(pkgRow);
    if (!pkg.active) throw new FeesError("package_inactive");
    await assertPayoutReady(scope.orgId, tx);
    const [pending] = await tx`
      select id from public.child_packages
      where org_id = ${scope.orgId} and child_id = ${scope.childId} and package_id = ${pkg.id} and status = 'pending_payment'
        and offer_expires_at > now()`;
    if (pending) throw new FeesError("offer_pending");
    const expiresAt = new Date(Date.now() + PACKAGE_OFFER_DAYS * 86_400_000);
    const pricePaise = pkg.price_inr * 100;
    const [cp] = await tx<{ id: string }[]>`
      insert into public.child_packages (org_id, child_id, package_id, snapshot, service_ids, price_paise, sessions_total, status,
                                         offer_expires_at, offered_by)
      values (${scope.orgId}, ${scope.childId}, ${pkg.id},
              ${tx.json({ name: pkg.name, session_count: pkg.session_count, price_inr: pkg.price_inr, validity_days: pkg.validity_days, service_ids: pkg.service_ids })},
              ${pkg.service_ids}::uuid[], ${pricePaise}, ${pkg.session_count}, 'pending_payment', ${expiresAt}, ${actor.actorUserId})
      returning id`;
    const { paymentId, link } = await createLinkRow(tx, gateway, {
      purpose: "package",
      orgId: scope.orgId,
      orgName: scope.orgName,
      childId: scope.childId,
      childPackageId: cp.id,
      amountPaise: pricePaise,
      description: pkg.name,
      expiresAt,
      createdBy: actor.actorUserId,
    });
    await enqueue(tx, {
      topic: "fees.payment_request",
      aggregateType: "payment",
      aggregateId: paymentId,
      payload: { payment_id: paymentId, child_id: scope.childId, kind: "package" },
      dedupKey: `payment:${paymentId}:request`,
    });
    await auditStrict(
      {
        ...actor,
        orgId: scope.orgId,
        childId: scope.childId,
        caseId: scope.caseId,
        action: "fees.package_offered",
        entity: "child_package",
        entityId: cp.id,
        details: { package_id: pkg.id, payment_id: paymentId, amount_paise: pricePaise, sessions: pkg.session_count },
      },
      tx,
    );
    return { child_package_id: cp.id, payment_id: paymentId, url: link.short_url, amount_paise: pricePaise };
  }) as Promise<OfferResult>;
}

// ---------- FR-7 `Request payment` ----------

/** Owner/admin: (re)creates the balance link for what is open and sends it to the guardian. */
export async function requestPayment(
  scope: { orgId: string; childId: string; caseId: string },
  actor: Actor,
  deps: { gateway?: PaymentGateway } = {},
): Promise<{ payment_id: string; url: string; amount_paise: number }> {
  const sql = await pg();
  return sql.begin(async (tx) => {
    const r = await refreshBalanceLink(scope.orgId, scope.childId, { gateway: deps.gateway, actorUserId: actor.actorUserId, tx });
    if (!r.payment_id || r.amount_paise < 100) throw new FeesError("nothing_due");
    const [link] = await tx<{ payment_link_url: string; amount_paise: number }[]>`
      select payment_link_url, amount_paise from public.payments where id = ${r.payment_id}`;
    await enqueue(tx, {
      topic: "fees.payment_request",
      aggregateType: "payment",
      aggregateId: r.payment_id,
      payload: { payment_id: r.payment_id, child_id: scope.childId, kind: "balance" },
      // At most one request message per link per day (a second tap the same day does not message the family again).
      dedupKey: `payment:${r.payment_id}:request:${todayIst()}`,
    });
    await auditStrict(
      {
        ...actor,
        orgId: scope.orgId,
        childId: scope.childId,
        caseId: scope.caseId,
        action: "fees.payment_requested",
        entity: "payment",
        entityId: r.payment_id,
        details: { amount_paise: link.amount_paise },
      },
      tx,
    );
    return { payment_id: r.payment_id, url: link.payment_link_url, amount_paise: link.amount_paise };
  }) as Promise<{ payment_id: string; url: string; amount_paise: number }>;
}

// ---------- FR-7 / FR-10 adjustments ----------

/** Owner/admin `Adjustment` with a reason: a signed ledger row (never an edit), then the balance link follows. */
export async function addAdjustment(
  scope: { orgId: string; childId: string; caseId: string },
  input: z.output<typeof AdjustmentSchema>,
  actor: Actor,
): Promise<{ ledger_id: string; balance_paise: number }> {
  const sql = await pg();
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${`fees-account:${scope.orgId}:${scope.childId}`}, 0))`;
    const amount = input.amount_inr * 100;
    const [row] = await tx<{ id: string }[]>`
      insert into public.family_ledger (org_id, child_id, kind, amount_paise, note, created_by)
      values (${scope.orgId}, ${scope.childId}, 'adjustment', ${amount}, ${input.reason}, ${actor.actorUserId})
      returning id`;
    await tx`select public.fees_request_link(${scope.orgId}, ${scope.childId})`;
    await auditStrict(
      {
        ...actor,
        orgId: scope.orgId,
        childId: scope.childId,
        caseId: scope.caseId,
        action: "fees.adjustment_added",
        entity: "family_ledger",
        entityId: String(row.id),
        details: { amount_paise: amount, reason: input.reason },
      },
      tx,
    );
    const [b] = await tx<{ b: string }[]>`select public.fees_balance(${scope.orgId}, ${scope.childId}) as b`;
    return { ledger_id: String(row.id), balance_paise: Number(b.b) };
  }) as Promise<{ ledger_id: string; balance_paise: number }>;
}

// ---------- FR-9 refunds ----------

export type RefundRequestResult = { fee_refund_id: string | null; payment_id: string; amount_paise: number; via: "fee_refund" | "payment" };

/** Hooks that must pass before a refund is sent to Razorpay (046: reverse the matching Route transfer first). */
export type RefundPrecondition = (refund: { id: string; payment_id: string; amount_paise: number; appointment_id: string | null; child_package_id: string | null }) => Promise<void>;
const preconditions: RefundPrecondition[] = [];
export function registerRefundPrecondition(hook: RefundPrecondition): void {
  preconditions.push(hook);
}
export function refundPreconditions(): readonly RefundPrecondition[] {
  return preconditions;
}

/**
 * Owner/admin: refund a package's unused sessions (price minus the used sessions' consultation amounts, minus anything
 * already refunded) or a paid session charge. The package stops being usable. Refunds run through the refund job
 * (lib/fees/jobs.ts) and add a `refund` ledger row when Razorpay confirms. Strict audit `fees.refund_requested`.
 */
export async function requestRefund(
  scope: { orgId: string; childId: string; caseId: string },
  input: z.output<typeof RefundSchema>,
  actor: Actor,
): Promise<RefundRequestResult> {
  const sql = await pg();
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${`fees-account:${scope.orgId}:${scope.childId}`}, 0))`;
    let result: RefundRequestResult;
    if (input.kind === "package") {
      const [cp] = await tx`
        select * from public.child_packages where id = ${input.child_package_id} and org_id = ${scope.orgId} and child_id = ${scope.childId}
        for update`;
      if (!cp) throw new FeesError("package_not_found");
      if (!["active", "used_up", "expired"].includes(String(cp.status)) || !cp.payment_id) throw new FeesError("not_refundable");
      const used = await tx<{ amount: number }[]>`
        select consultation_amount_paise as amount from public.appointments where child_package_id = ${cp.id} and consultation_amount_paise is not null`;
      const [done] = await tx<{ n: string }[]>`
        select coalesce(sum(amount_paise), 0)::text as n from public.fee_refunds where payment_id = ${cp.payment_id}`;
      const amount = packageRefundPaise(Number(cp.price_paise), used.map((u) => Number(u.amount)), Number(done.n));
      if (amount <= 0) throw new FeesError("nothing_to_refund");
      const [r] = await tx<{ id: string }[]>`
        insert into public.fee_refunds (org_id, child_id, payment_id, amount_paise, reason, child_package_id, note, requested_by)
        values (${scope.orgId}, ${scope.childId}, ${cp.payment_id}, ${amount}, 'package_unused', ${cp.id}, ${input.reason}, ${actor.actorUserId})
        returning id`;
      await tx`update public.child_packages set status = 'cancelled', cancel_reason = 'refunded', updated_at = now() where id = ${cp.id}`;
      result = { fee_refund_id: r.id, payment_id: String(cp.payment_id), amount_paise: amount, via: "fee_refund" };
    } else {
      const [a] = await tx`
        select id, org_id, child_id from public.appointments where id = ${input.appointment_id} and org_id = ${scope.orgId}
          and child_id = ${scope.childId} for update`;
      if (!a) throw new FeesError("not_refundable");
      const [prepaid] = await tx<{ id: string; amount_paise: number }[]>`
        select id, amount_paise from public.payments where appointment_id = ${a.id} and purpose = 'appointment' and status = 'captured'`;
      if (prepaid) {
        await tx`select public.payment_request_refund(${prepaid.id}, 'session_refund')`;
        result = { fee_refund_id: null, payment_id: prepaid.id, amount_paise: prepaid.amount_paise, via: "payment" };
      } else {
        const [charge] = await tx<{ id: string | null }[]>`select public.fees_open_charge(${a.id}) as id`;
        if (!charge?.id) throw new FeesError("not_refundable");
        const [settled] = await tx<{ id: string | null }[]>`select public.fees_settled_by(${charge.id}) as id`;
        if (!settled?.id) throw new FeesError("not_paid");
        const [c] = await tx<{ amount_paise: number }[]>`select amount_paise from public.family_ledger where id = ${charge.id}`;
        const [r] = await tx<{ id: string }[]>`
          insert into public.fee_refunds (org_id, child_id, payment_id, amount_paise, reason, appointment_id, charge_ledger_id, note, requested_by)
          values (${scope.orgId}, ${scope.childId}, ${settled.id}, ${c.amount_paise}, 'session_charge', ${a.id}, ${charge.id}, ${input.reason}, ${actor.actorUserId})
          returning id`;
        result = { fee_refund_id: r.id, payment_id: settled.id, amount_paise: c.amount_paise, via: "fee_refund" };
      }
    }
    await auditStrict(
      {
        ...actor,
        orgId: scope.orgId,
        childId: scope.childId,
        caseId: scope.caseId,
        action: "fees.refund_requested",
        entity: result.fee_refund_id ? "fee_refund" : "payment",
        entityId: result.fee_refund_id ?? result.payment_id,
        details: { kind: input.kind, amount_paise: result.amount_paise, payment_id: result.payment_id, reason: input.reason },
      },
      tx,
    );
    return result;
  }) as Promise<RefundRequestResult>;
}

// ---------- link capture (webhook, signed redirect, demo) ----------

export type LinkPaidResult = {
  payment_id: string;
  outcome: "package_active" | "balance_paid" | "already_captured" | "duplicate_payment" | "refund_amount_mismatch" | "refund_package_unavailable";
  payment_status: string;
  receipt_no: string | null;
  purpose?: string;
  child_package_id?: string | null;
  refund?: boolean;
};

export async function applyLinkPaid(
  input: { linkId: string; paymentId: string; amountPaise?: number | null; capturedAt?: Date | null; source: "webhook" | "callback" | "demo" },
  tx?: Tx,
): Promise<LinkPaidResult> {
  const run = async (t: Tx): Promise<LinkPaidResult> => {
    const [row] = await t<{ r: LinkPaidResult }[]>`
      select public.fees_apply_link_paid(${input.linkId}, ${input.paymentId}, ${input.amountPaise ?? null}::int,
                                         ${input.capturedAt ?? null}::timestamptz) as r`;
    const r = row.r;
    if (r.outcome !== "already_captured") {
      const [scope] = await t<{ org_id: string; child_id: string | null }[]>`select org_id, child_id from public.payments where id = ${r.payment_id}`;
      await auditStrict(
        {
          actor: "system",
          actorRole: "system",
          orgId: scope?.org_id ?? null,
          childId: scope?.child_id ?? null,
          action: "payment.captured",
          entity: "payment",
          entityId: r.payment_id,
          details: { outcome: r.outcome, source: input.source, purpose: r.purpose ?? null, receipt_no: r.receipt_no },
        },
        t,
      );
    }
    return r;
  };
  if (tx) return run(tx);
  const sql = await pg();
  return sql.begin(run) as Promise<LinkPaidResult>;
}

export async function closeLink(linkId: string, reason: string, sql?: Queryable): Promise<string> {
  const db = sql ?? (await pg());
  const [row] = await db<{ r: { outcome: string } }[]>`select public.fees_close_link(${linkId}, ${reason}) as r`;
  return row.r.outcome;
}

export async function findLinkPayment(linkId: string): Promise<{ id: string; org_id: string; child_id: string | null; status: string; amount_paise: number; gateway: string; purpose: string; razorpay_payment_link_id: string; receipt_no: string | null; org_name: string; description: string | null } | null> {
  const sql = await pg();
  const [row] = await sql`
    select p.id, p.org_id, p.child_id, p.status, p.amount_paise, p.gateway, p.purpose, p.razorpay_payment_link_id, p.receipt_no,
           o.name as org_name, cp.snapshot ->> 'name' as description
    from public.payments p join public.organizations o on o.id = p.org_id
    left join public.child_packages cp on cp.id = p.child_package_id
    where p.razorpay_payment_link_id = ${linkId}`;
  return row
    ? {
        id: String(row.id),
        org_id: String(row.org_id),
        child_id: (row.child_id as string | null) ?? null,
        status: String(row.status),
        amount_paise: Number(row.amount_paise),
        gateway: String(row.gateway),
        purpose: String(row.purpose),
        razorpay_payment_link_id: String(row.razorpay_payment_link_id),
        receipt_no: (row.receipt_no as string | null) ?? null,
        org_name: String(row.org_name),
        description: (row.description as string | null) ?? null,
      }
    : null;
}

// ---------- reads ----------

function toLedger(r: Record<string, unknown>): LedgerRow {
  return {
    id: String(r.id),
    kind: r.kind as LedgerKind,
    amount_paise: Number(r.amount_paise),
    note: String(r.note),
    appointment_id: (r.appointment_id as string | null) ?? null,
    child_package_id: (r.child_package_id as string | null) ?? null,
    payment_id: (r.payment_id as string | null) ?? null,
    receipt_no: (r.receipt_no as string | null) ?? null,
    created_at: iso(r.created_at) as string,
    session_at: iso(r.session_at),
    package_name: (r.package_name as string | null) ?? null,
    manual: r.created_by !== null && r.created_by !== undefined && r.kind === "adjustment",
  };
}

/** One account (organisation x child): balance, open link, packages, ledger (newest first). */
export async function loadAccount(orgId: string, childId: string, opts: { ledgerLimit?: number } = {}): Promise<Account> {
  const sql = await pg();
  const [org] = await sql<{ id: string; name: string }[]>`select id, name from public.organizations where id = ${orgId}`;
  const [balance] = await sql<{ b: string }[]>`select public.fees_balance(${orgId}, ${childId}) as b`;
  const [link] = await sql`
    select id, payment_link_url, amount_paise, link_expires_at from public.payments
    where org_id = ${orgId} and child_id = ${childId} and purpose = 'balance' and status = 'created'
    order by created_at desc limit 1`;
  const packages = await sql.unsafe(
    `${CHILD_PACKAGE_SELECT}
     where cp.org_id = $1 and cp.child_id = $2
       and (cp.status in ('active', 'used_up') or (cp.status = 'pending_payment' and cp.offer_expires_at > now())
            or cp.updated_at > now() - interval '90 days')
     order by case cp.status when 'active' then 0 when 'pending_payment' then 1 else 2 end, cp.created_at desc`,
    [orgId, childId],
  );
  const ledger = await sql`
    select l.id, l.kind, l.amount_paise, l.note, l.appointment_id, l.child_package_id, l.payment_id, l.receipt_no, l.created_at,
           l.created_by, lower(a.slot) as session_at, cp.snapshot ->> 'name' as package_name
    from public.family_ledger l
    left join public.appointments a on a.id = l.appointment_id
    left join public.child_packages cp on cp.id = l.child_package_id
    where l.org_id = ${orgId} and l.child_id = ${childId}
    order by l.id desc
    limit ${opts.ledgerLimit ?? 200}`;
  const refunds = await sql`
    select id, amount_paise, reason, created_at from public.fee_refunds
    where org_id = ${orgId} and child_id = ${childId} and status = 'pending' order by created_at`;
  const [oldest] = await sql<{ at: Date | null }[]>`
    select min(coalesce(lower(a.slot), i.created_at)) as at
    from public.fees_open_items(${orgId}, ${childId}) i left join public.appointments a on a.id = i.appointment_id
    where i.kind = 'charge'`;
  const pkgs = packages.map((p) => toChildPackage(p as Record<string, unknown>));
  const today = todayIst();
  const oldestAt = iso(oldest?.at ?? null);
  const balancePaise = Number(balance.b);
  return {
    org: { id: orgId, name: org?.name ?? "" },
    child_id: childId,
    balance_paise: balancePaise,
    balance_link: link
      ? { payment_id: String(link.id), purpose: "balance", url: String(link.payment_link_url), amount_paise: Number(link.amount_paise), expires_at: iso(link.link_expires_at) }
      : null,
    packages: pkgs,
    ledger: ledger.map(toLedger),
    pending_refunds: refunds.map((r) => ({ id: String(r.id), amount_paise: Number(r.amount_paise), reason: String(r.reason), created_at: iso(r.created_at) as string })),
    oldest_unpaid_at: oldestAt,
    overdue: balancePaise > 0 && balanceOverdue(oldestAt),
    package_ending: pkgs.some((p) => p.status === "active" && packageEnding(p, today)),
  };
}

/** FR-5: every organisation account of a child (any money activity, an offer, or a case there). */
export async function listChildAccounts(childId: string): Promise<Account[]> {
  const sql = await pg();
  const orgs = await sql<{ org_id: string }[]>`
    select org_id from public.family_ledger where child_id = ${childId}
    union select org_id from public.child_packages where child_id = ${childId}
    union select org_id from public.payments where child_id = ${childId} and purpose <> 'appointment'`;
  const accounts: Account[] = [];
  for (const o of orgs) accounts.push(await loadAccount(o.org_id, childId, { ledgerLimit: 100 }));
  return accounts.sort((a, b) => a.org.name.localeCompare(b.org.name));
}

export type BalanceDueRow = {
  org_id: string;
  org_name: string;
  child_id: string;
  child_name: string;
  case_id: string | null;
  balance_paise: number;
  oldest_unpaid_at: string | null;
  overdue: boolean;
  package_ending: boolean;
  package_left: number | null;
};

/** FR-7 `/dashboard/fees`: children with a balance due or an ending package in the given organisations. */
export async function listBalancesDue(orgIds: string[]): Promise<BalanceDueRow[]> {
  if (!orgIds.length) return [];
  const sql = await pg();
  const rows = await sql`
    with accounts as (
      select org_id, child_id from public.family_ledger where org_id = any(${orgIds}::uuid[]) group by org_id, child_id
      union select org_id, child_id from public.child_packages where org_id = any(${orgIds}::uuid[]) and status = 'active'
    )
    select ac.org_id, o.name as org_name, ac.child_id, ch.display_name as child_name,
           (select c.id from public.cases c where c.org_id = ac.org_id and c.child_id = ac.child_id order by c.created_at desc limit 1) as case_id,
           public.fees_balance(ac.org_id, ac.child_id) as balance,
           (select min(coalesce(lower(a.slot), i.created_at)) from public.fees_open_items(ac.org_id, ac.child_id) i
            left join public.appointments a on a.id = i.appointment_id where i.kind = 'charge') as oldest,
           (select json_build_object('total', cp.sessions_total, 'used', cp.sessions_used, 'expires_on', cp.expires_on)
            from public.child_packages cp where cp.org_id = ac.org_id and cp.child_id = ac.child_id and cp.status = 'active'
            order by cp.expires_on limit 1) as pkg
    from accounts ac
    join public.organizations o on o.id = ac.org_id
    join public.children ch on ch.id = ac.child_id`;
  const today = todayIst();
  return rows
    .map((r) => {
      const pkg = r.pkg as { total: number; used: number; expires_on: string } | null;
      const balance = Number(r.balance);
      const oldest = iso(r.oldest);
      return {
        org_id: String(r.org_id),
        org_name: String(r.org_name),
        child_id: String(r.child_id),
        child_name: String(r.child_name),
        case_id: (r.case_id as string | null) ?? null,
        balance_paise: balance,
        oldest_unpaid_at: oldest,
        overdue: balance > 0 && balanceOverdue(oldest),
        package_ending: pkg ? packageEnding({ sessions_total: pkg.total, sessions_used: pkg.used, expires_on: day(pkg.expires_on) }, today) : false,
        package_left: pkg ? pkg.total - pkg.used : null,
      };
    })
    .filter((r) => r.balance_paise !== 0 || r.package_ending)
    .sort((a, b) => Number(b.overdue) - Number(a.overdue) || b.balance_paise - a.balance_paise);
}

/** Open payment links of an account (for `Show QR`). */
export async function listOpenLinks(orgId: string, childId: string): Promise<OpenLink[]> {
  const sql = await pg();
  const rows = await sql`
    select id, purpose, payment_link_url, amount_paise, link_expires_at from public.payments
    where org_id = ${orgId} and child_id = ${childId} and purpose <> 'appointment' and status = 'created'
      and (link_expires_at is null or link_expires_at > now())
    order by created_at desc`;
  return rows.map((r) => ({
    payment_id: String(r.id),
    purpose: r.purpose as "package" | "balance",
    url: String(r.payment_link_url),
    amount_paise: Number(r.amount_paise),
    expires_at: iso(r.link_expires_at),
  }));
}

export type PaymentScope = {
  id: string;
  purpose: "appointment" | "package" | "balance";
  status: string;
  org_id: string;
  org_name: string;
  child_id: string | null;
  url: string | null;
  amount_paise: number;
  receipt_no: string | null;
  razorpay_payment_id: string | null;
  captured_at: string | null;
  guardian_user_id: string | null;
};

/** A payment with its organisation and child (link payments directly, one-offs through the appointment). */
export async function getPaymentScope(paymentId: string): Promise<PaymentScope | null> {
  const sql = await pg();
  const [r] = await sql`
    select p.id, p.purpose, p.status, coalesce(p.org_id, a.org_id) as org_id, o.name as org_name,
           coalesce(p.child_id, a.child_id) as child_id, p.payment_link_url, p.amount_paise, p.receipt_no,
           p.razorpay_payment_id, p.captured_at, a.guardian_user_id
    from public.payments p
    left join public.appointments a on a.id = p.appointment_id
    join public.organizations o on o.id = coalesce(p.org_id, a.org_id)
    where p.id = ${paymentId}`;
  if (!r) return null;
  return {
    id: String(r.id),
    purpose: r.purpose as PaymentScope["purpose"],
    status: String(r.status),
    org_id: String(r.org_id),
    org_name: String(r.org_name),
    child_id: (r.child_id as string | null) ?? null,
    url: (r.payment_link_url as string | null) ?? null,
    amount_paise: Number(r.amount_paise),
    receipt_no: (r.receipt_no as string | null) ?? null,
    razorpay_payment_id: (r.razorpay_payment_id as string | null) ?? null,
    captured_at: iso(r.captured_at),
    guardian_user_id: (r.guardian_user_id as string | null) ?? null,
  };
}

// ---------- 046 seam ----------

export type Consultation = {
  appointment_id: string;
  org_id: string;
  child_id: string | null;
  source: "one_off" | "package" | "per_session";
  consultation_amount_paise: number;
  /** payments.id that funds it (null = not paid yet). */
  payment_id: string | null;
  razorpay_payment_id: string | null;
  payment_amount_paise: number | null;
  /** Everything refunded from that payment so far (031 full refund or 045 partial refunds). */
  refunded_paise: number;
  child_package_id: string | null;
  marked_at: string | null;
};

/** For 046 (Route payouts): every billable appointment with its consultation amount and the captured payment that
 * funds it. Filter by organisation and/or appointment. */
export async function listConsultations(filter: { orgId?: string; appointmentId?: string } = {}, sql?: Queryable): Promise<Consultation[]> {
  const db = sql ?? (await pg());
  const rows = await db`select * from public.fees_consultations(${filter.orgId ?? null}::uuid, ${filter.appointmentId ?? null}::uuid)`;
  return rows.map((r) => ({
    appointment_id: String(r.appointment_id),
    org_id: String(r.org_id),
    child_id: (r.child_id as string | null) ?? null,
    source: r.source as Consultation["source"],
    consultation_amount_paise: Number(r.consultation_amount_paise),
    payment_id: (r.payment_id as string | null) ?? null,
    razorpay_payment_id: (r.razorpay_payment_id as string | null) ?? null,
    payment_amount_paise: r.payment_amount_paise === null ? null : Number(r.payment_amount_paise),
    refunded_paise: Number(r.refunded_paise ?? 0),
    child_package_id: (r.child_package_id as string | null) ?? null,
    marked_at: iso(r.marked_at),
  }));
}

// ---------- route helpers ----------

/** Maps fee errors for the API routes (FeesError codes, audit failures, missing Razorpay configuration). */
export async function feesRouteError(err: unknown): Promise<Response | null> {
  if (err instanceof FeesError) return feesErrorResponse(err.code);
  const { AuditWriteError, auditFailure } = await import("@/lib/audit");
  if (err instanceof AuditWriteError) return auditFailure(err);
  const { RazorpayConfigError } = await import("@/lib/payments/razorpay");
  if (err instanceof RazorpayConfigError) return feesErrorResponse("not_configured");
  return null;
}

/** FR-9: paid sessions that owner/admin can still refund (one-off prepayments still captured, paid session charges). */
export async function listRefundableSessions(orgId: string, childId: string): Promise<{ appointment_id: string; starts_at: string; service: string; amount_paise: number }[]> {
  const sql = await pg();
  const rows = await sql`
    select a.id, lower(a.slot) as starts_at, a.service_snapshot ->> 'name' as service, c.consultation_amount_paise as amount
    from public.fees_consultations(${orgId}::uuid, null) c
    join public.appointments a on a.id = c.appointment_id
    left join public.payments p on p.id = c.payment_id
    where c.child_id = ${childId} and c.source <> 'package' and c.payment_id is not null
      and (c.source <> 'one_off' or p.status = 'captured')
    order by lower(a.slot) desc
    limit 50`;
  return rows.map((r) => ({ appointment_id: String(r.id), starts_at: iso(r.starts_at) as string, service: String(r.service ?? ""), amount_paise: Number(r.amount) }));
}

/** 043 note: a package-billed weekly timetable continues after the package runs out (warn staff). */
export async function packageSeriesWithoutCover(orgId: string, childId: string): Promise<boolean> {
  const sql = await pg();
  const [row] = await sql<{ warn: boolean }[]>`
    select exists (
      select 1 from public.appointment_series s
      where s.org_id = ${orgId} and s.child_id = ${childId} and s.status = 'active' and s.billing_mode = 'package'
    ) and not exists (
      select 1 from public.child_packages cp
      where cp.org_id = ${orgId} and cp.child_id = ${childId} and cp.status = 'active'
        and cp.sessions_total - cp.sessions_used > 2
    ) as warn`;
  return Boolean(row?.warn);
}
