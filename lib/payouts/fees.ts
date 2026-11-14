// Ticket 046: pure payout maths (no I/O; the SQL twin is payouts_fee_split in
// supabase/migrations/20261113004600_payouts.sql - tests compare both). Integer paise, half-up rounding.
//   fee  = percent of the consultation (basis points) or flat, clamped to min / cap, 0 while waived (D-5);
//   GST  = fee x PLATFORM_GST_BPS (default 1800 = 18%);
//   net  = consultation - fee - GST (the fee is reduced so that net is never negative).

export type FeePolicyKind = "percent" | "flat";

export type FeePolicy = {
  kind: FeePolicyKind;
  percent_bps: number | null;
  flat_paise: number | null;
  min_paise: number;
  cap_paise: number | null;
  /** YYYY-MM-DD (Asia/Kolkata): consultations on or before this date have no fee. */
  waived_until: string | null;
  /** 0 = the platform default (PLATFORM_FEE_DEFAULT_BPS), 1.. = the organisation's own versions. */
  version: number;
};

export type FeeSplit = { fee_paise: number; gst_paise: number; net_paise: number };

export const DEFAULT_FEE_BPS = 1000;
export const DEFAULT_GST_BPS = 1800;
export const MAX_FEE_BPS = 3000;

export function defaultPolicy(defaultBps: number): FeePolicy {
  return { kind: "percent", percent_bps: defaultBps, flat_paise: null, min_paise: 0, cap_paise: null, waived_until: null, version: 0 };
}

/** Whether the waiver covers a consultation on `onDate` (YYYY-MM-DD). */
export function isWaived(policy: Pick<FeePolicy, "waived_until">, onDate: string): boolean {
  return policy.waived_until !== null && onDate <= policy.waived_until;
}

export function splitFee(amountPaise: number, policy: Omit<FeePolicy, "version" | "waived_until">, opts: { waived: boolean; gstBps: number }): FeeSplit {
  if (!(amountPaise > 0) || opts.waived) return { fee_paise: 0, gst_paise: 0, net_paise: Math.max(amountPaise, 0) };
  let fee = policy.kind === "flat" ? (policy.flat_paise ?? 0) : Math.floor((amountPaise * (policy.percent_bps ?? 0) + 5000) / 10000);
  fee = Math.max(fee, policy.min_paise ?? 0);
  if (policy.cap_paise !== null && policy.cap_paise !== undefined) fee = Math.min(fee, policy.cap_paise);
  let gst = Math.floor((fee * opts.gstBps + 5000) / 10000);
  if (fee + gst > amountPaise) {
    fee = Math.floor((amountPaise * 10000) / (10000 + opts.gstBps));
    gst = Math.floor((fee * opts.gstBps + 5000) / 10000);
    if (fee + gst > amountPaise) gst = amountPaise - fee;
  }
  return { fee_paise: fee, gst_paise: gst, net_paise: amountPaise - fee - gst };
}

/** The split for a consultation on `onDate` under `policy`. */
export function splitFor(amountPaise: number, policy: FeePolicy, onDate: string, gstBps: number): FeeSplit & { waived: boolean } {
  const waived = isWaived(policy, onDate);
  return { ...splitFee(amountPaise, policy, { waived, gstBps }), waived };
}

/** Transfer retries after a failed attempt n (1-based): 1 min, 10 min, 1 h; after the 3rd retry an admin decides. */
export const TRANSFER_BACKOFF_SECONDS = [60, 600, 3600];
export const TRANSFER_LEASE_SECONDS = 120;

// ---------- reconciliation (FR-10) ----------

export type ReconRow = { captured_paise: number; transferred_paise: number; platform_share_paise: number; refunded_paise: number };

/** transferred + refunded + platform share - captured (0 = balanced). */
export function reconDiff(r: ReconRow): number {
  return r.transferred_paise + r.refunded_paise + r.platform_share_paise - r.captured_paise;
}

// ---------- invoices (FR-7) ----------

/** Indian financial year of an instant (Asia/Kolkata), e.g. 2026-27. Same rule as fees_financial_year(). */
export function financialYear(at: Date): string {
  const local = new Date(at.getTime() + 330 * 60_000);
  const y = local.getUTCFullYear();
  const start = local.getUTCMonth() >= 3 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

export function invoiceNumber(fy: string, n: number): string {
  return `DNM-INV/${fy}/${String(n).padStart(4, "0")}`;
}

/** YYYY-MM-01 of the month before `now` (Asia/Kolkata): what the cron on the 1st invoices. */
export function previousMonthIst(now: Date): string {
  const local = new Date(now.getTime() + 330 * 60_000);
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  const prev = m === 0 ? { y: y - 1, m: 12 } : { y, m };
  return `${prev.y}-${String(prev.m).padStart(2, "0")}-01`;
}

/** GST split for the invoice: CGST + SGST when the centre's GSTIN is in the platform's state, else IGST. */
export function gstLines(gstPaise: number, platformGstin: string | null, centreGstin: string | null): { label: string; paise: number }[] {
  if (platformGstin && centreGstin && platformGstin.slice(0, 2) === centreGstin.slice(0, 2)) {
    const half = Math.floor(gstPaise / 2);
    return [
      { label: "CGST 9%", paise: half },
      { label: "SGST 9%", paise: gstPaise - half },
    ];
  }
  return [{ label: "IGST 18%", paise: gstPaise }];
}

// ---------- CSV (FR-7 export) ----------

/** One CSV cell: quoted when needed, and neutralised when a spreadsheet would read text as a formula. */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  let s = String(value);
  if (typeof value !== "number" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r']/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvLine(cells: (string | number | null | undefined)[]): string {
  return cells.map(csvCell).join(",");
}

export const rupees = (paise: number): string => (paise / 100).toFixed(2);
