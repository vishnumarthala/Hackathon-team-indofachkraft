// Ticket 045: pure money rules (no I/O), mirrored by the SQL in supabase/migrations/20261113004500_packages_family_payments.sql.
// Amounts are integer paise (NFR-1); display goes through formatInr.

/** D-4: the consultation amount of session `n` (1-based) of a package: price / sessions rounded down, remainder on the last. */
export function packageSessionAmount(pricePaise: number, sessionsTotal: number, n: number): number {
  if (!Number.isInteger(pricePaise) || !Number.isInteger(sessionsTotal) || sessionsTotal < 1) throw new Error("invalid package");
  if (n < 1 || n > sessionsTotal) throw new Error("session out of range");
  const unit = Math.floor(pricePaise / sessionsTotal);
  return n === sessionsTotal ? pricePaise - unit * (sessionsTotal - 1) : unit;
}

/** FR-9: what a package refund returns: the price minus the consultation amounts of the sessions already used. */
export function packageRefundPaise(pricePaise: number, usedAmountsPaise: readonly number[], alreadyRefundedPaise = 0): number {
  const used = usedAmountsPaise.reduce((sum, n) => sum + n, 0);
  return Math.max(0, pricePaise - used - alreadyRefundedPaise);
}

/** The Indian financial year (1 April - 31 March) of an instant, in Asia/Kolkata: `2026-27`. */
export function financialYear(at: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit" }).formatToParts(at);
  const year = Number(parts.find((p) => p.type === "year")?.value);
  const month = Number(parts.find((p) => p.type === "month")?.value);
  const start = month >= 4 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

export const RECEIPT_PATTERN = /^DNM\/\d{4}-\d{2}\/\d{6,}$/;

export type LedgerKind = "charge" | "payment" | "refund" | "adjustment";

/** A ledger row's effect on the balance due (refunds return money together with the part of a charge they cancel). */
export function balanceEffect(kind: LedgerKind, amountPaise: number): number {
  switch (kind) {
    case "charge":
      return amountPaise;
    case "payment":
      return -amountPaise;
    case "adjustment":
      return amountPaise;
    default:
      return 0;
  }
}

export function balanceOf(rows: readonly { kind: LedgerKind; amount_paise: number }[]): number {
  return rows.reduce((sum, r) => sum + balanceEffect(r.kind, r.amount_paise), 0);
}

export const BALANCE_REMINDER_DAYS = 3;
export const PACKAGE_LOW_SESSIONS = 2;
export const PACKAGE_EXPIRY_WARNING_DAYS = 7;
export const PACKAGE_OFFER_DAYS = 7;

/** Whole days from `today` to `date` (both YYYY-MM-DD). */
export function daysUntil(date: string, today: string): number {
  return Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}

/** FR-8: a package is "ending" with <= 2 sessions left or expiring within 7 days (dates are YYYY-MM-DD, IST). */
export function packageEnding(p: { sessions_total: number; sessions_used: number; expires_on: string | null }, today: string): boolean {
  if (!p.expires_on) return false;
  return p.sessions_total - p.sessions_used <= PACKAGE_LOW_SESSIONS || daysUntil(p.expires_on, today) <= PACKAGE_EXPIRY_WARNING_DAYS;
}

/** FR-8: a balance is overdue when an unpaid session charge is for a session more than 3 days ago. */
export function balanceOverdue(oldestUnpaidAt: string | null, now = Date.now()): boolean {
  if (!oldestUnpaidAt) return false;
  return now - Date.parse(oldestUnpaidAt) >= BALANCE_REMINDER_DAYS * 86_400_000;
}
