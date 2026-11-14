// Ticket 046: payout accounts, fee policies, the centre's payout statement and the admin overview. Server-only (shared
// Postgres pool). Callers gate first (lib/payouts/authz.ts); every change writes a strict audit row in the same
// transaction (041). The money side (items, transfers, reversals, invoices, reconciliation) is SQL in
// supabase/migrations/20261113004600_payouts.sql, driven by lib/payouts/jobs.ts.
import { z } from "zod";
import { auditStrict, type SessionAuditActor } from "@/lib/audit";
import { pg, type Queryable } from "@/lib/pg";
import { demoId } from "@/lib/payments/razorpay";
import { payoutConfig } from "./config";
import { defaultPolicy, type FeePolicy } from "./fees";

if (typeof window !== "undefined") {
  throw new Error("lib/payouts/store.ts is server-only");
}

export type Actor = SessionAuditActor & { actorUserId: string };

// ---------- errors ----------

export const PAYOUTS_ERRORS = {
  payout_account_inactive: { status: 409, error: "Finish payout setup to accept payments." },
  fee_policy_not_accepted: { status: 409, error: "Accept the platform fee on the Payouts page before taking payments." },
  policy_changed: { status: 409, error: "The platform fee changed. Read the new notice and accept it." },
  not_owner: { status: 403, error: "Only the organisation owner can accept the platform fee." },
  account_id_required: { status: 400, error: "Enter the Razorpay linked account id (acc_...)." },
  not_retryable: { status: 409, error: "This payout cannot be retried." },
  not_found: { status: 404, error: "Not found" },
} as const;
export type PayoutsErrorCode = keyof typeof PAYOUTS_ERRORS;

export class PayoutsError extends Error {
  constructor(readonly code: PayoutsErrorCode) {
    super(code);
    this.name = "PayoutsError";
  }
}

export function payoutsErrorResponse(code: PayoutsErrorCode): Response {
  const { status, error } = PAYOUTS_ERRORS[code];
  return Response.json({ error, code }, { status });
}

/** Maps payout errors (and fail-closed audit errors) for the API routes; null = not ours, rethrow. */
export async function payoutsRouteError(err: unknown): Promise<Response | null> {
  if (err instanceof PayoutsError) return payoutsErrorResponse(err.code);
  const { AuditWriteError, auditFailure } = await import("@/lib/audit");
  if (err instanceof AuditWriteError) return auditFailure(err);
  return null;
}

// ---------- schemas ----------

export const ACCOUNT_STATUSES = ["not_started", "pending_kyc", "active", "suspended"] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export const AccountInputSchema = z
  .object({
    status: z.enum(ACCOUNT_STATUSES),
    razorpay_account_id: z
      .string()
      .trim()
      .regex(/^acc_[A-Za-z0-9]{6,40}$/, { error: "A Razorpay linked account id looks like acc_XXXXXXXXXXXXXX" })
      .nullable()
      .optional(),
    legal_name: z.string().trim().max(200).nullable().optional(),
  })
  .strict();

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { error: "Use a date (YYYY-MM-DD)" });
export const PolicyInputSchema = z
  .object({
    kind: z.enum(["percent", "flat"]),
    percent_bps: z.number().int().min(0).max(3000, { error: "At most 30%" }).nullable().optional(),
    flat_paise: z.number().int().min(0).max(10_000_000).nullable().optional(),
    min_paise: z.number().int().min(0).max(10_000_000).default(0),
    cap_paise: z.number().int().min(0).max(10_000_000).nullable().optional(),
    waived_until: isoDate.nullable().optional(),
  })
  .strict()
  .refine((v) => (v.kind === "percent" ? typeof v.percent_bps === "number" : typeof v.flat_paise === "number"), {
    error: "Enter the percentage or the flat amount",
    path: ["kind"],
  })
  .refine((v) => v.cap_paise === null || v.cap_paise === undefined || v.cap_paise >= v.min_paise, {
    error: "The cap must be at least the minimum",
    path: ["cap_paise"],
  });

export const AcceptSchema = z.object({ policy_version: z.number().int().min(0) }).strict();

export const SettingsSchema = z
  .object({
    package_expiry_policy: z.enum(["pay_centre", "refund_family"]).optional(),
    gstin: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[0-9]{2}[A-Z0-9]{13}$/, { error: "A GSTIN has 15 characters, starting with the 2-digit state code" })
      .nullable()
      .optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { error: "Nothing to update" });

// ---------- rows ----------

export type PayoutAccount = {
  org_id: string;
  status: AccountStatus;
  razorpay_account_id: string | null;
  legal_name: string | null;
  gstin: string | null;
  /** False = never set up (DEMO_MODE: a fake active demo account). */
  explicit: boolean;
  updated_at: string | null;
};

export type Readiness = {
  account: PayoutAccount;
  policy: FeePolicy;
  /** The current policy version was accepted (or this is an implicit DEMO_MODE organisation). */
  accepted: boolean;
  /** FR-2: paid services are bookable. */
  canCharge: boolean;
  /** FR-2 / FR-8: new paid services and packages may go live. */
  canPublish: boolean;
  block: "payout_account_inactive" | "fee_policy_not_accepted" | null;
  demoImplicit: boolean;
  package_expiry_policy: "pay_centre" | "refund_family";
};

const iso = (v: unknown): string | null => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : String(v));
const day = (v: unknown): string | null => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

export async function getPayoutAccount(orgId: string, sql?: Queryable): Promise<PayoutAccount> {
  const db = sql ?? (await pg());
  const { demo } = payoutConfig();
  const [row] = await db`
    select a.status, a.razorpay_account_id, a.explicit, x.legal_name, x.gstin, x.updated_at
    from public.payouts_account(${orgId}::uuid, ${demo}) a
    left join public.org_payout_accounts x on x.org_id = ${orgId}::uuid`;
  return {
    org_id: orgId,
    status: row.status as AccountStatus,
    razorpay_account_id: (row.razorpay_account_id as string | null) ?? null,
    legal_name: (row.legal_name as string | null) ?? null,
    gstin: (row.gstin as string | null) ?? null,
    explicit: Boolean(row.explicit),
    updated_at: iso(row.updated_at),
  };
}

function toPolicy(r: Record<string, unknown>): FeePolicy {
  return {
    kind: r.kind as FeePolicy["kind"],
    percent_bps: r.percent_bps === null || r.percent_bps === undefined ? null : Number(r.percent_bps),
    flat_paise: r.flat_paise === null || r.flat_paise === undefined ? null : Number(r.flat_paise),
    min_paise: Number(r.min_paise ?? 0),
    cap_paise: r.cap_paise === null || r.cap_paise === undefined ? null : Number(r.cap_paise),
    waived_until: day(r.waived_until),
    version: Number(r.version ?? 0),
  };
}

export async function getFeePolicy(orgId: string, sql?: Queryable): Promise<FeePolicy> {
  const db = sql ?? (await pg());
  const { defaultFeeBps } = payoutConfig();
  const [row] = await db`select * from public.platform_fee_policies where org_id = ${orgId}`;
  return row ? toPolicy(row) : defaultPolicy(defaultFeeBps);
}

function policyJson(p: FeePolicy) {
  return {
    kind: p.kind,
    percent_bps: p.percent_bps,
    flat_paise: p.flat_paise,
    min_paise: p.min_paise,
    cap_paise: p.cap_paise,
    waived_until: p.waived_until,
    version: p.version,
  };
}

async function isAccepted(db: Queryable, orgId: string, policy: FeePolicy): Promise<boolean> {
  const [row] = await db<{ policy: { percent_bps?: number | null } }[]>`
    select policy from public.fee_policy_acceptances where org_id = ${orgId} and policy_version = ${policy.version}`;
  if (!row) return false;
  // Version 0 is the platform default: an acceptance holds only while the default it showed is unchanged.
  return policy.version > 0 || row.policy?.percent_bps === policy.percent_bps;
}

/** FR-2 / FR-8: can this organisation take payments, and publish new paid services or packages? */
export async function payoutReadiness(orgId: string, sql?: Queryable): Promise<Readiness> {
  const db = sql ?? (await pg());
  const { demo } = payoutConfig();
  const account = await getPayoutAccount(orgId, db);
  const policy = await getFeePolicy(orgId, db);
  const demoImplicit = demo && !account.explicit;
  const accepted = demoImplicit || (await isAccepted(db, orgId, policy));
  const canCharge = account.status === "active";
  const [org] = await db<{ package_expiry_policy: "pay_centre" | "refund_family" }[]>`
    select package_expiry_policy from public.organizations where id = ${orgId}`;
  const block = !canCharge ? "payout_account_inactive" : !accepted ? "fee_policy_not_accepted" : null;
  return { account, policy, accepted, canCharge, canPublish: block === null, block, demoImplicit, package_expiry_policy: org?.package_expiry_policy ?? "pay_centre" };
}

/** Throws PayoutsError when the organisation may not publish paid services or offer packages (FR-2, FR-8). */
export async function assertCanPublishPaid(orgId: string, sql?: Queryable): Promise<void> {
  const r = await payoutReadiness(orgId, sql);
  if (r.block) throw new PayoutsError(r.block);
}

// ---------- admin: payout accounts and fee policies (FR-2, FR-9) ----------

export async function setPayoutAccount(orgId: string, input: z.output<typeof AccountInputSchema>, actor: Actor): Promise<PayoutAccount> {
  const { demo } = payoutConfig();
  const sql = await pg();
  await sql.begin(async (tx) => {
    const [org] = await tx`select id from public.organizations where id = ${orgId} for update`;
    if (!org) throw new PayoutsError("not_found");
    const [current] = await tx`select razorpay_account_id, legal_name from public.org_payout_accounts where org_id = ${orgId}`;
    let accountId = input.razorpay_account_id === undefined ? ((current?.razorpay_account_id as string | null) ?? null) : input.razorpay_account_id;
    if ((input.status === "active" || input.status === "suspended") && !accountId) {
      // DEMO_MODE fakes the linked account (KYC is a human step in the Razorpay dashboard).
      if (!demo) throw new PayoutsError("account_id_required");
      accountId = demoId("acc", orgId);
    }
    const legalName = input.legal_name === undefined ? ((current?.legal_name as string | null) ?? null) : input.legal_name || null;
    await tx`
      insert into public.org_payout_accounts (org_id, razorpay_account_id, status, legal_name, updated_by, updated_at)
      values (${orgId}, ${accountId}, ${input.status}, ${legalName}, ${actor.actorUserId}, now())
      on conflict (org_id) do update set razorpay_account_id = excluded.razorpay_account_id, status = excluded.status,
        legal_name = excluded.legal_name, updated_by = excluded.updated_by, updated_at = now()`;
    await auditStrict(
      {
        ...actor,
        orgId,
        action: "payouts.account_changed",
        entity: "organization",
        entityId: orgId,
        details: { status: input.status, account_last4: accountId ? accountId.slice(-4) : null },
      },
      tx,
    );
  });
  return getPayoutAccount(orgId);
}

export async function setFeePolicy(orgId: string, input: z.output<typeof PolicyInputSchema>, actor: Actor): Promise<FeePolicy> {
  const sql = await pg();
  await sql.begin(async (tx) => {
    const [org] = await tx`select id from public.organizations where id = ${orgId} for update`;
    if (!org) throw new PayoutsError("not_found");
    const [current] = await tx<{ version: number }[]>`select version from public.platform_fee_policies where org_id = ${orgId} for update`;
    const version = (current?.version ?? 0) + 1;
    const p: FeePolicy = {
      kind: input.kind,
      percent_bps: input.kind === "percent" ? (input.percent_bps ?? 0) : null,
      flat_paise: input.kind === "flat" ? (input.flat_paise ?? 0) : null,
      min_paise: input.min_paise ?? 0,
      cap_paise: input.cap_paise ?? null,
      waived_until: input.waived_until ?? null,
      version,
    };
    await tx`
      insert into public.platform_fee_policies (org_id, kind, percent_bps, flat_paise, min_paise, cap_paise, waived_until, version, updated_by, updated_at)
      values (${orgId}, ${p.kind}, ${p.percent_bps}, ${p.flat_paise}, ${p.min_paise}, ${p.cap_paise}, ${p.waived_until}::date, ${version},
              ${actor.actorUserId}, now())
      on conflict (org_id) do update set kind = excluded.kind, percent_bps = excluded.percent_bps, flat_paise = excluded.flat_paise,
        min_paise = excluded.min_paise, cap_paise = excluded.cap_paise, waived_until = excluded.waived_until,
        version = excluded.version, updated_by = excluded.updated_by, updated_at = now()`;
    await tx`
      insert into public.platform_fee_policy_versions (org_id, version, policy, created_by)
      values (${orgId}, ${version}, ${tx.json(policyJson(p))}, ${actor.actorUserId})`;
    await auditStrict(
      { ...actor, orgId, action: "payouts.fee_policy_changed", entity: "organization", entityId: orgId, details: policyJson(p) },
      tx,
    );
  });
  return getFeePolicy(orgId);
}

/** FR-9 `Retry`: a failed transfer (or one waiting for the payout account) is tried again now, with fresh retries. */
export async function retryPayoutItem(itemId: string, actor: Actor): Promise<{ id: string; org_id: string }> {
  const sql = await pg();
  return sql.begin(async (tx) => {
    const [it] = await tx<{ id: string; org_id: string; status: string; reverse_requested_at: Date | null; failure_reason: string | null }[]>`
      select id, org_id, status, reverse_requested_at, failure_reason from public.payout_items where id = ${itemId} for update`;
    if (!it) throw new PayoutsError("not_found");
    if (!(it.status === "failed" || it.status === "pending") || it.reverse_requested_at || it.failure_reason === "exceeds_payment") {
      throw new PayoutsError("not_retryable");
    }
    await tx`update public.payout_items set attempts = 0, next_attempt_at = now(), locked_until = null, updated_at = now() where id = ${itemId}`;
    await auditStrict(
      { ...actor, orgId: it.org_id, action: "payouts.transfer_retried", entity: "payout_item", entityId: itemId, details: { status: it.status, failure_reason: it.failure_reason } },
      tx,
    );
    return { id: it.id, org_id: it.org_id };
  }) as Promise<{ id: string; org_id: string }>;
}

// ---------- owner / admin of the organisation (FR-6, FR-7, FR-8) ----------

/** FR-8: the owner accepts the current policy version (once per version). */
export async function acceptFeePolicy(orgId: string, version: number, actor: Actor): Promise<Readiness> {
  const sql = await pg();
  await sql.begin(async (tx) => {
    await tx`select id from public.organizations where id = ${orgId} for update`;
    const policy = await getFeePolicy(orgId, tx);
    if (policy.version !== version) throw new PayoutsError("policy_changed");
    await tx`
      insert into public.fee_policy_acceptances (org_id, policy_version, policy, accepted_by)
      values (${orgId}, ${version}, ${tx.json(policyJson(policy))}, ${actor.actorUserId})
      on conflict (org_id, policy_version) do update set policy = excluded.policy, accepted_by = excluded.accepted_by, accepted_at = now()`;
    await auditStrict(
      { ...actor, orgId, action: "payouts.fee_policy_accepted", entity: "organization", entityId: orgId, details: policyJson(policy) },
      tx,
    );
  });
  return payoutReadiness(orgId);
}

export async function setPayoutSettings(orgId: string, input: z.output<typeof SettingsSchema>, actor: Actor): Promise<Readiness> {
  const sql = await pg();
  await sql.begin(async (tx) => {
    if (input.package_expiry_policy) {
      await tx`update public.organizations set package_expiry_policy = ${input.package_expiry_policy} where id = ${orgId}`;
    }
    if (input.gstin !== undefined) {
      await tx`
        insert into public.org_payout_accounts (org_id, gstin, updated_by, updated_at)
        values (${orgId}, ${input.gstin}, ${actor.actorUserId}, now())
        on conflict (org_id) do update set gstin = excluded.gstin, updated_by = excluded.updated_by, updated_at = now()`;
    }
    await auditStrict(
      {
        ...actor,
        orgId,
        action: "payouts.settings_changed",
        entity: "organization",
        entityId: orgId,
        details: { package_expiry_policy: input.package_expiry_policy ?? null, gstin_set: input.gstin === undefined ? null : input.gstin !== null },
      },
      tx,
    );
  });
  return payoutReadiness(orgId);
}

// ---------- statement (FR-7) ----------

export type PayoutItemStatus = "pending" | "transferred" | "on_hold" | "released" | "reversed" | "failed";

export type PayoutItemRow = {
  id: string;
  org_id: string;
  kind: "consultation" | "package_expiry";
  appointment_id: string | null;
  session_at: string | null;
  consultation_on: string;
  service: string | null;
  child_name: string | null;
  consultation_paise: number;
  fee_paise: number;
  gst_paise: number;
  net_paise: number;
  fee_waived: boolean;
  status: PayoutItemStatus;
  processed_at: string | null;
  failure_reason: string | null;
  attempts: number;
  next_attempt_at: string | null;
  razorpay_transfer_id: string | null;
  reverse_requested: boolean;
};

function toItem(r: Record<string, unknown>): PayoutItemRow {
  return {
    id: String(r.id),
    org_id: String(r.org_id),
    kind: r.kind as PayoutItemRow["kind"],
    appointment_id: (r.appointment_id as string | null) ?? null,
    session_at: iso(r.session_at),
    consultation_on: day(r.consultation_on) as string,
    service: (r.service as string | null) ?? null,
    child_name: (r.child_name as string | null) ?? null,
    consultation_paise: Number(r.consultation_paise),
    fee_paise: Number(r.fee_paise),
    gst_paise: Number(r.gst_paise),
    net_paise: Number(r.net_paise),
    fee_waived: Boolean(r.fee_waived),
    status: r.status as PayoutItemStatus,
    processed_at: iso(r.processed_at),
    failure_reason: (r.failure_reason as string | null) ?? null,
    attempts: Number(r.attempts ?? 0),
    next_attempt_at: iso(r.next_attempt_at),
    razorpay_transfer_id: (r.razorpay_transfer_id as string | null) ?? null,
    reverse_requested: r.reverse_requested_at !== null && r.reverse_requested_at !== undefined,
  };
}

const ITEM_SELECT = `
  select i.id, i.org_id, i.kind, i.appointment_id, lower(a.slot) as session_at, i.consultation_on,
         coalesce(a.service_snapshot ->> 'name', cp.snapshot ->> 'name') as service,
         ch.display_name as child_name, i.consultation_paise, i.fee_paise, i.gst_paise, i.net_paise, i.fee_waived,
         i.status, i.processed_at, i.failure_reason, i.attempts, i.next_attempt_at, i.razorpay_transfer_id,
         i.reverse_requested_at
  from public.payout_items i
  left join public.appointments a on a.id = i.appointment_id
  left join public.child_packages cp on cp.id = i.child_package_id
  left join public.children ch on ch.id = coalesce(a.child_id, cp.child_id) and ch.deleted_at is null`;

export async function listPayoutItems(orgId: string, opts: { from?: string; to?: string; limit?: number } = {}): Promise<PayoutItemRow[]> {
  const sql = await pg();
  const rows = await sql.unsafe(
    `${ITEM_SELECT}
     where i.org_id = $1 and ($2::date is null or i.consultation_on >= $2::date) and ($3::date is null or i.consultation_on <= $3::date)
     order by i.consultation_on desc, lower(a.slot) desc nulls last, i.created_at desc
     limit $4`,
    [orgId, opts.from ?? null, opts.to ?? null, opts.limit ?? 200],
  );
  return rows.map((r) => toItem(r as Record<string, unknown>));
}

export type Totals = { consultations: number; gross_paise: number; fee_gst_paise: number; paid_out_paise: number };
export type Statement = { week: Totals; month: Totals; week_from: string; month_from: string };

/** This week's (Monday-based) and this month's consultations by session date (Asia/Kolkata). */
export async function payoutStatement(orgId: string, now: Date = new Date()): Promise<Statement> {
  const sql = await pg();
  const [r] = await sql`
    with d as (select (${now}::timestamptz at time zone 'Asia/Kolkata')::date as today),
    b as (select date_trunc('week', today)::date as week_from, date_trunc('month', today)::date as month_from from d)
    select b.week_from, b.month_from,
      count(*) filter (where i.consultation_on >= b.week_from) as w_n,
      coalesce(sum(i.consultation_paise) filter (where i.consultation_on >= b.week_from), 0) as w_gross,
      coalesce(sum(i.fee_paise + i.gst_paise) filter (where i.consultation_on >= b.week_from), 0) as w_fee,
      coalesce(sum(i.net_paise) filter (where i.consultation_on >= b.week_from and i.status in ('transferred', 'released')), 0) as w_paid,
      count(*) filter (where i.consultation_on >= b.month_from) as m_n,
      coalesce(sum(i.consultation_paise) filter (where i.consultation_on >= b.month_from), 0) as m_gross,
      coalesce(sum(i.fee_paise + i.gst_paise) filter (where i.consultation_on >= b.month_from), 0) as m_fee,
      coalesce(sum(i.net_paise) filter (where i.consultation_on >= b.month_from and i.status in ('transferred', 'released')), 0) as m_paid
    from b
    left join public.payout_items i on i.org_id = ${orgId} and i.status <> 'reversed'
      and i.consultation_on >= least(b.week_from, b.month_from)
    group by b.week_from, b.month_from`;
  const totals = (n: unknown, g: unknown, f: unknown, p: unknown): Totals => ({
    consultations: Number(n),
    gross_paise: Number(g),
    fee_gst_paise: Number(f),
    paid_out_paise: Number(p),
  });
  return {
    week: totals(r.w_n, r.w_gross, r.w_fee, r.w_paid),
    month: totals(r.m_n, r.m_gross, r.m_fee, r.m_paid),
    week_from: day(r.week_from) as string,
    month_from: day(r.month_from) as string,
  };
}

export type InvoiceRow = {
  id: string;
  org_id: string;
  period_month: string;
  invoice_no: string;
  fee_paise: number;
  gst_paise: number;
  gross_paise: number;
  item_count: number;
  pdf_path: string;
  issued_at: string;
  centre: { name: string; legal_name: string | null; gstin: string | null };
  platform: { legal_name: string; gstin: string | null; address: string | null };
};

function toInvoice(r: Record<string, unknown>): InvoiceRow {
  return {
    id: String(r.id),
    org_id: String(r.org_id),
    period_month: day(r.period_month) as string,
    invoice_no: String(r.invoice_no),
    fee_paise: Number(r.fee_paise),
    gst_paise: Number(r.gst_paise),
    gross_paise: Number(r.gross_paise),
    item_count: Number(r.item_count),
    pdf_path: String(r.pdf_path),
    issued_at: iso(r.issued_at) as string,
    centre: r.centre as InvoiceRow["centre"],
    platform: r.platform as InvoiceRow["platform"],
  };
}

export async function listInvoices(orgId: string): Promise<InvoiceRow[]> {
  const sql = await pg();
  const rows = await sql`select * from public.platform_invoices where org_id = ${orgId} order by period_month desc limit 36`;
  return rows.map((r) => toInvoice(r as Record<string, unknown>));
}

export async function getInvoice(orgId: string, invoiceId: string): Promise<InvoiceRow | null> {
  const sql = await pg();
  const [row] = await sql`select * from public.platform_invoices where id = ${invoiceId} and org_id = ${orgId}`;
  return row ? toInvoice(row as Record<string, unknown>) : null;
}

// ---------- admin overview (FR-9) ----------

export type AdminOrgRow = {
  org_id: string;
  name: string;
  account: PayoutAccount;
  policy: FeePolicy;
  accepted: boolean;
  month_paid_out_paise: number;
  month_fee_paise: number;
  failed: number;
  hidden_paid_services: number;
};

export type AdminOverview = {
  month_from: string;
  gmv_paise: number;
  fee_paise: number;
  gst_paise: number;
  failed_transfers: number;
  orgs: AdminOrgRow[];
  attention: (PayoutItemRow & { org_name: string; exhausted: boolean })[];
  open_reconciliation_flags: number;
};

export async function adminPayoutOverview(now: Date = new Date()): Promise<AdminOverview> {
  const sql = await pg();
  const { demo } = payoutConfig();
  const [m] = await sql`
    with b as (select date_trunc('month', (${now}::timestamptz at time zone 'Asia/Kolkata'))::date as month_from)
    select b.month_from,
      (select coalesce(sum(p.amount_paise), 0) from public.payments p
       where p.status in ('captured', 'refund_pending', 'refunded')
         and (p.captured_at at time zone 'Asia/Kolkata')::date >= b.month_from) as gmv,
      (select coalesce(sum(i.fee_paise), 0) from public.payout_items i where i.status <> 'reversed' and i.consultation_on >= b.month_from) as fee,
      (select coalesce(sum(i.gst_paise), 0) from public.payout_items i where i.status <> 'reversed' and i.consultation_on >= b.month_from) as gst,
      (select count(*) from public.payout_items i where i.status = 'failed') as failed,
      (select count(*) from public.payout_reconciliation_flags f where f.resolved_at is null) as flags
    from b`;
  const orgRows = await sql<{ id: string; name: string }[]>`
    select o.id, o.name from public.organizations o
    where exists (select 1 from public.org_payout_accounts a where a.org_id = o.id)
       or exists (select 1 from public.platform_fee_policies p where p.org_id = o.id)
       or exists (select 1 from public.payout_items i where i.org_id = o.id)
       or exists (select 1 from public.services s where s.org_id = o.id and s.active and s.payment_mode = 'online' and s.fee_inr > 0)
    order by o.name
    limit 500`;
  const orgs: AdminOrgRow[] = [];
  for (const o of orgRows) {
    const r = await payoutReadiness(o.id, sql);
    const [s] = await sql`
      select
        coalesce(sum(net_paise) filter (where status in ('transferred', 'released') and consultation_on >= ${day(m.month_from)}::date), 0) as paid,
        coalesce(sum(fee_paise) filter (where status <> 'reversed' and consultation_on >= ${day(m.month_from)}::date), 0) as fee,
        count(*) filter (where status = 'failed') as failed,
        (select count(*) from public.services sv where sv.org_id = ${o.id} and sv.active and sv.payment_mode = 'online' and sv.fee_inr > 0
           and not public.payouts_org_can_charge(${o.id}::uuid, ${demo})) as hidden
      from public.payout_items where org_id = ${o.id}`;
    orgs.push({
      org_id: o.id,
      name: o.name,
      account: r.account,
      policy: r.policy,
      accepted: r.accepted,
      month_paid_out_paise: Number(s.paid),
      month_fee_paise: Number(s.fee),
      failed: Number(s.failed),
      hidden_paid_services: Number(s.hidden),
    });
  }
  const attention = await sql.unsafe(
    `select x.*, o.name as org_name from (${ITEM_SELECT}
       where i.status in ('failed', 'on_hold') or (i.status = 'pending' and i.failure_reason = 'payout_account_inactive')) x
     join public.organizations o on o.id = x.org_id
     order by x.consultation_on desc limit 100`,
  );
  return {
    month_from: day(m.month_from) as string,
    gmv_paise: Number(m.gmv),
    fee_paise: Number(m.fee),
    gst_paise: Number(m.gst),
    failed_transfers: Number(m.failed),
    orgs,
    attention: attention.map((r) => ({
      ...toItem(r as Record<string, unknown>),
      org_name: String(r.org_name),
      exhausted: r.status === "failed" && (r.next_attempt_at === null || r.next_attempt_at === undefined),
    })),
    open_reconciliation_flags: Number(m.flags),
  };
}
