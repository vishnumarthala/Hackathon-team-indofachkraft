import { getFormatter, getT } from "@/lib/i18n/server";
import { KIND_STYLE, ledgerItemLabel, ledgerSign } from "@/lib/fees/display";
import type { LedgerRow } from "@/lib/fees/store";

// 045 FR-5 / FR-7: the account history (newest first) with receipt downloads for captured payments. Server component.
export async function LedgerTable({ rows, receiptBase }: { rows: LedgerRow[]; receiptBase: string }) {
  const t = await getT("fees");
  const format = await getFormatter();
  if (!rows.length) return <p className="text-sm text-slate-600">{t("caseTab.ledgerEmpty")}</p>;
  const tt = t as unknown as (key: string, values?: Record<string, string | number>) => string;
  return (
    <ul className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white text-sm" data-testid="fees-ledger">
      {rows.map((r) => (
        <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-3">
          <div className="min-w-0 space-y-0.5">
            <p className="break-words text-slate-900">
              <span className={`mr-2 inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${KIND_STYLE[r.kind]}`}>{t(`kinds.${r.kind}`)}</span>
              {ledgerItemLabel(r, tt, format)}
            </p>
            <p className="text-xs text-slate-600">
              {format.date(r.created_at)}
              {r.receipt_no && r.payment_id ? (
                <>
                  {" · "}
                  <a className="font-medium text-teal-800 underline" href={`${receiptBase}/${r.payment_id}/receipt`} data-testid="receipt-link">
                    {t("caseTab.receipt", { number: r.receipt_no })}
                  </a>
                </>
              ) : null}
            </p>
          </div>
          <span className="whitespace-nowrap font-semibold text-slate-900">
            {ledgerSign(r)}
            {format.inr(Math.abs(r.amount_paise))}
          </span>
        </li>
      ))}
    </ul>
  );
}
