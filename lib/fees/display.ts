// Ticket 045: pure display helpers for the family account (case Fees tab, family Payments page). Pages pass their
// translator (`fees` namespace) and formatter.
import type { LedgerRow } from "./store";

type T = (key: string, values?: Record<string, string | number>) => string;
type F = { date: (value: string | Date) => string };

const SYSTEM_NOTES = new Set(["session", "appointment", "package", "balance", "session_not_billable", "paid_after_cancel", "unallocated_payment"]);

/** What a ledger row is about, in the reader's language (manual adjustments show the reason staff typed). */
export function ledgerItemLabel(row: Pick<LedgerRow, "kind" | "note" | "session_at" | "package_name" | "manual">, t: T, format: F): string {
  if (row.kind === "refund") return t("items.refund");
  if (row.kind === "adjustment" && (row.manual || !SYSTEM_NOTES.has(row.note))) return row.note;
  switch (row.note) {
    case "session":
      return row.session_at ? t("items.session", { date: format.date(row.session_at) }) : t("items.sessionNoDate");
    case "appointment":
      return row.session_at ? t("items.appointment", { date: format.date(row.session_at) }) : t("items.sessionNoDate");
    case "package":
      return row.package_name ? t("items.package", { name: row.package_name }) : t("items.packageNoName");
    case "balance":
      return t("items.balance");
    case "session_not_billable":
      return t("items.notBillable");
    case "paid_after_cancel":
      return t("items.paidAfterCancel");
    case "unallocated_payment":
      return t("items.unallocated");
    default:
      return row.note;
  }
}

/** Signed effect for display: charges and debits `+`, payments and credits `-`, refunds shown as money back. */
export function ledgerSign(row: Pick<LedgerRow, "kind" | "amount_paise">): "+" | "-" | "" {
  if (row.kind === "charge") return "+";
  if (row.kind === "payment") return "-";
  if (row.kind === "adjustment") return row.amount_paise < 0 ? "-" : "+";
  return "";
}

export const KIND_STYLE: Record<LedgerRow["kind"], string> = {
  charge: "bg-slate-100 text-slate-800",
  payment: "bg-teal-50 text-teal-900",
  refund: "bg-sky-50 text-sky-900",
  adjustment: "bg-amber-50 text-amber-900",
};
