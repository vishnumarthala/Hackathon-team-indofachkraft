"use client";

import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { buttonClass, inputClass, labelClass, secondaryButtonClass, send, type ApiResult } from "@/components/providers/request";
import { useFormatter, useT } from "@/lib/i18n/client";

type Option = { id: string; label: string };
type Link = { payment_id: string; purpose: "package" | "balance"; amount: string };

const ERROR_CODES = [
  "nothing_due",
  "nothing_to_refund",
  "not_refundable",
  "not_paid",
  "offer_pending",
  "package_inactive",
  "package_not_found",
  "not_configured",
  "gateway_error",
  "payout_account_inactive",
  "fee_policy_not_accepted",
] as const;

const selectClass = `${inputClass} min-h-11`;

// 045 FR-7: the Fees tab's actions. Owner/admin: `Offer package`, `Request payment`, `Adjustment` (reason required)
// and refunds; everyone with case access: `Show payment QR` for the open links (the desk screen).
export function FeesActions({
  caseId,
  canManage,
  centre,
  packages,
  links,
  refundablePackages,
  refundableSessions,
}: {
  caseId: string;
  canManage: boolean;
  centre: string;
  packages: Option[];
  links: Link[];
  refundablePackages: Option[];
  refundableSessions: Option[];
}) {
  const t = useT("fees.caseTab");
  const format = useFormatter();
  const router = useRouter();
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [showQr, setShowQr] = useState(false);
  const base = `/api/cases/${caseId}/fees`;

  function errorText(res: ApiResult): string {
    const code = res.json.code;
    if (typeof code === "string" && (ERROR_CODES as readonly string[]).includes(code)) return t(`errors.${code as (typeof ERROR_CODES)[number]}`);
    if (res.status === 403) return t("errors.forbidden");
    if (res.status === 400) return t("errors.invalid");
    return t("errors.generic");
  }

  async function act(url: string, body: unknown, success: (json: Record<string, unknown>) => string): Promise<boolean> {
    setBusy(true);
    setMessage(null);
    const res = await send(url, "POST", body);
    setBusy(false);
    if (!res.ok) {
      setMessage({ ok: false, text: errorText(res) });
      return false;
    }
    setMessage({ ok: true, text: success(res.json) });
    router.refresh();
    return true;
  }

  async function offer(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    if (await act(`${base}/offer`, { package_id: String(f.get("package_id") ?? "") }, () => t("offerSent"))) setShowQr(true);
  }

  async function adjust(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const ok = await act(`${base}/adjustments`, { amount_inr: Number(f.get("amount_inr")), reason: String(f.get("reason") ?? "") }, () => t("adjustmentSaved"));
    if (ok) form.reset();
  }

  async function refund(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const target = String(f.get("target") ?? "");
    const [kind, targetId] = target.split(":");
    const body = kind === "package" ? { kind, child_package_id: targetId, reason: String(f.get("reason") ?? "") } : { kind: "session", appointment_id: targetId, reason: String(f.get("reason") ?? "") };
    const ok = await act(`${base}/refunds`, body, (json) => t("refundRequested", { amount: format.inr(Number(json.amount_paise ?? 0)) }));
    if (ok) form.reset();
  }

  return (
    <section aria-labelledby={`${id}-actions`} className="space-y-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
      <h3 id={`${id}-actions`} className="font-semibold text-slate-900">
        {t("actions")}
      </h3>

      <div className="flex flex-wrap gap-3">
        {canManage ? (
          <button
            type="button"
            className={buttonClass}
            disabled={busy}
            onClick={async () => {
              if (await act(`${base}/request-payment`, {}, (json) => t("requestSent", { amount: format.inr(Number(json.amount_paise ?? 0)) }))) setShowQr(true);
            }}
          >
            {t("requestPayment")}
          </button>
        ) : null}
        <button type="button" className={secondaryButtonClass} onClick={() => setShowQr((v) => !v)} aria-expanded={showQr} aria-controls={`${id}-qr`}>
          {showQr ? t("hideQr") : t("showQr")}
        </button>
      </div>

      {message ? (
        <p role={message.ok ? "status" : "alert"} className={message.ok ? "text-sm text-teal-900" : "text-sm text-red-800"} data-testid="fees-message">
          {message.text}
        </p>
      ) : null}

      {showQr ? (
        <div id={`${id}-qr`} className="space-y-3" data-testid="fees-qr">
          {links.length === 0 ? <p className="text-sm text-slate-700">{t("noOpenLink")}</p> : null}
          {links.map((l) => (
            <figure key={l.payment_id} className="inline-block space-y-2 rounded-xl border border-slate-200 bg-white p-3 text-center">
              {/* eslint-disable-next-line @next/next/no-img-element -- a same-origin SVG generated per request */}
              <img src={`/api/fees/payments/${l.payment_id}/qr`} alt={t("qrAlt", { amount: l.amount })} width={240} height={240} className="mx-auto h-60 w-60" />
              <figcaption className="max-w-60 text-sm text-slate-800">
                <span className="block font-semibold">
                  {l.purpose === "package" ? t("qrPackage") : t("qrBalance")}: {l.amount}
                </span>
                {t("qrCaption", { amount: l.amount, centre })}
              </figcaption>
            </figure>
          ))}
        </div>
      ) : null}

      {canManage ? (
        <div className="grid gap-4 lg:grid-cols-3">
          <form onSubmit={offer} className="space-y-2 rounded border border-slate-200 bg-white p-3" aria-label={t("offerPackage")}>
            <h4 className="font-medium text-slate-900">{t("offerPackage")}</h4>
            {packages.length === 0 ? (
              <p className="text-sm text-slate-700">{t("noPackages")}</p>
            ) : (
              <>
                <label htmlFor={`${id}-pkg`} className={labelClass}>
                  {t("choosePackage")}
                </label>
                <select id={`${id}-pkg`} name="package_id" className={selectClass} required>
                  {packages.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
                <button type="submit" className={buttonClass} disabled={busy}>
                  {t("sendOffer")}
                </button>
              </>
            )}
          </form>

          <form onSubmit={adjust} className="space-y-2 rounded border border-slate-200 bg-white p-3" aria-label={t("adjustment")}>
            <h4 className="font-medium text-slate-900">{t("adjustment")}</h4>
            <label htmlFor={`${id}-amt`} className={labelClass}>
              {t("adjustmentAmount")}
            </label>
            <input id={`${id}-amt`} name="amount_inr" type="number" step={1} min={-100000} max={100000} required className={inputClass} />
            <label htmlFor={`${id}-why`} className={labelClass}>
              {t("adjustmentReason")}
            </label>
            <input id={`${id}-why`} name="reason" required minLength={3} maxLength={300} className={inputClass} />
            <button type="submit" className={buttonClass} disabled={busy}>
              {t("addAdjustment")}
            </button>
          </form>

          <form onSubmit={refund} className="space-y-2 rounded border border-slate-200 bg-white p-3" aria-label={t("refund")}>
            <h4 className="font-medium text-slate-900">{t("refund")}</h4>
            {refundablePackages.length + refundableSessions.length === 0 ? (
              <p className="text-sm text-slate-700">{t("errors.nothing_to_refund")}</p>
            ) : (
              <>
                <label htmlFor={`${id}-ref`} className={labelClass}>
                  {t("refund")}
                </label>
                <select id={`${id}-ref`} name="target" className={selectClass} required>
                  {refundablePackages.map((p) => (
                    <option key={p.id} value={`package:${p.id}`}>
                      {t("refundPackage")}: {p.label}
                    </option>
                  ))}
                  {refundableSessions.map((s) => (
                    <option key={s.id} value={`session:${s.id}`}>
                      {t("refundSession")}: {s.label}
                    </option>
                  ))}
                </select>
                <label htmlFor={`${id}-refwhy`} className={labelClass}>
                  {t("refundReason")}
                </label>
                <input id={`${id}-refwhy`} name="reason" required minLength={3} maxLength={300} className={inputClass} />
                <button type="submit" className={secondaryButtonClass} disabled={busy}>
                  {t("refund")}
                </button>
              </>
            )}
          </form>
        </div>
      ) : (
        <p className="text-sm text-slate-700">{t("managersOnly")}</p>
      )}
    </section>
  );
}
