"use client";

import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { fieldKeys, inputClass, labelClass, secondaryButtonClass, send } from "@/components/providers/request";
import { useT } from "@/lib/i18n/client";
import { Button } from "@/components/ui/Button";

// 046 FR-6 / FR-7 / FR-8: the centre's payout forms on /dashboard/payouts (owner/admin). The fee notice is accepted by
// the owner only; the server re-checks everything (lib/payouts/authz.ts).

function useSend() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [invalid, setInvalid] = useState<string[]>([]);
  async function run(url: string, method: string, body: unknown, texts: { ok: string; fail: (status: number, code: unknown) => string }) {
    setBusy(true);
    setMessage(null);
    const res = await send(url, method, body);
    setBusy(false);
    setInvalid(fieldKeys(res.json));
    if (!res.ok) {
      setMessage({ ok: false, text: texts.fail(res.status, res.json.code) });
      return false;
    }
    setMessage({ ok: true, text: texts.ok });
    router.refresh();
    return true;
  }
  const feedback = message ? (
    <p role={message.ok ? "status" : "alert"} className={`text-sm ${message.ok ? "text-teal-800" : "text-red-700"}`}>
      {message.text}
    </p>
  ) : null;
  return { busy, run, feedback, invalid };
}

export function AcceptFeeButton({ orgId, version, canAccept }: { orgId: string; version: number; canAccept: boolean }) {
  const t = useT("payouts.fee");
  const { busy, run, feedback } = useSend();
  if (!canAccept) return <p className="text-sm text-slate-700">{t("ownerOnly")}</p>;
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button
        type="button"
        disabled={busy}
        onClick={() =>
          run(`/api/orgs/${orgId}/payouts/accept`, "POST", { policy_version: version }, {
            ok: t("accepted", { version }),
            fail: (status, code) => (code === "policy_changed" ? t("changed") : status === 403 ? t("ownerOnly") : t("failed")),
          })
        }
      >
        {t("accept")}
      </Button>
      {feedback}
    </div>
  );
}

export function PayoutSettingsForm({ orgId, expiryPolicy, gstin }: { orgId: string; expiryPolicy: "pay_centre" | "refund_family"; gstin: string | null }) {
  const t = useT("payouts.settings");
  const id = useId();
  const { busy, run, feedback, invalid } = useSend();
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const raw = String(f.get("gstin") ?? "").trim();
    await run(
      `/api/orgs/${orgId}/payouts/settings`,
      "PUT",
      { package_expiry_policy: String(f.get("package_expiry_policy")), gstin: raw ? raw : null },
      { ok: t("saved"), fail: (status) => (status === 400 ? t("invalid") : t("failed")) },
    );
  }
  return (
    <form onSubmit={submit} className="space-y-3" aria-label={t("title")}>
      <fieldset className="space-y-2">
        <legend className={labelClass}>{t("expiry")}</legend>
        {(["pay_centre", "refund_family"] as const).map((v) => (
          <label key={v} className="flex min-h-11 items-center gap-2 text-sm text-slate-800">
            <input type="radio" name="package_expiry_policy" value={v} defaultChecked={expiryPolicy === v} className="h-5 w-5" />
            {v === "pay_centre" ? t("payCentre") : t("refundFamily")}
          </label>
        ))}
      </fieldset>
      <div>
        <label htmlFor={`${id}-gstin`} className={labelClass}>{t("gstin")}</label>
        <input id={`${id}-gstin`} name="gstin" defaultValue={gstin ?? ""} maxLength={15} autoComplete="off" className={`${inputClass} uppercase`} aria-invalid={invalid.includes("gstin") || undefined} />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className={secondaryButtonClass} disabled={busy}>{t("save")}</button>
        {feedback}
      </div>
    </form>
  );
}

// ---------- admin (/admin/payouts) ----------

type AccountStatus = "not_started" | "pending_kyc" | "active" | "suspended";
type Policy = { kind: "percent" | "flat"; percent_bps: number | null; flat_paise: number | null; min_paise: number; cap_paise: number | null; waived_until: string | null };

export function AdminCentreForms({
  orgId,
  account,
  policy,
}: {
  orgId: string;
  account: { status: AccountStatus; razorpay_account_id: string | null; legal_name: string | null; explicit: boolean };
  policy: Policy;
}) {
  const t = useT("payouts.admin");
  const id = useId();
  const acc = useSend();
  const pol = useSend();
  const [kind, setKind] = useState<"percent" | "flat">(policy.kind);
  const rupeesOf = (paise: number | null) => (paise === null ? "" : String(paise / 100));
  const paiseOf = (v: FormDataEntryValue | null) => {
    const s = String(v ?? "").trim();
    return s === "" ? null : Math.round(Number(s) * 100);
  };

  async function saveAccount(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const accountId = String(f.get("razorpay_account_id") ?? "").trim();
    await acc.run(
      `/api/admin/payouts/orgs/${orgId}/account`,
      "PUT",
      { status: String(f.get("status")), razorpay_account_id: accountId || null, legal_name: String(f.get("legal_name") ?? "").trim() || null },
      { ok: t("saved"), fail: (status) => (status === 400 ? t("invalid") : t("failedSave")) },
    );
  }

  async function savePolicy(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const percent = String(f.get("percent") ?? "").trim();
    await pol.run(
      `/api/admin/payouts/orgs/${orgId}/policy`,
      "PUT",
      {
        kind,
        percent_bps: kind === "percent" ? Math.round(Number(percent || 0) * 100) : null,
        flat_paise: kind === "flat" ? (paiseOf(f.get("flat")) ?? 0) : null,
        min_paise: paiseOf(f.get("min")) ?? 0,
        cap_paise: paiseOf(f.get("cap")),
        waived_until: String(f.get("waived_until") ?? "") || null,
      },
      { ok: t("saved"), fail: (status) => (status === 400 ? t("invalid") : t("failedSave")) },
    );
  }

  const bad = (list: string[], field: string) => list.includes(field) || undefined;
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <form onSubmit={saveAccount} className="space-y-3 rounded border border-slate-200 bg-slate-50 p-3" aria-label={t("accountTitle")}>
        <h3 className="font-semibold text-slate-900">{t("accountTitle")}</h3>
        <div>
          <label htmlFor={`${id}-status`} className={labelClass}>{t("status")}</label>
          <select id={`${id}-status`} name="status" defaultValue={account.explicit ? account.status : "not_started"} className={`${inputClass} min-h-11`}>
            {(["not_started", "pending_kyc", "active", "suspended"] as const).map((s) => (
              <option key={s} value={s}>{t(`accountStatus.${s}`)}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={`${id}-acc`} className={labelClass}>{t("accountId")}</label>
          <input id={`${id}-acc`} name="razorpay_account_id" defaultValue={account.explicit ? (account.razorpay_account_id ?? "") : ""} className={inputClass} autoComplete="off" aria-invalid={bad(acc.invalid, "razorpay_account_id")} aria-describedby={`${id}-acc-hint`} />
          <p id={`${id}-acc-hint`} className="mt-1 text-xs text-slate-600">{t("accountIdHint")}</p>
        </div>
        <div>
          <label htmlFor={`${id}-legal`} className={labelClass}>{t("legalName")}</label>
          <input id={`${id}-legal`} name="legal_name" defaultValue={account.legal_name ?? ""} maxLength={200} className={inputClass} />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={acc.busy}>{t("saveAccount")}</Button>
          {acc.feedback}
        </div>
      </form>
      <form onSubmit={savePolicy} className="space-y-3 rounded border border-slate-200 bg-slate-50 p-3" aria-label={t("policyTitle")}>
        <h3 className="font-semibold text-slate-900">{t("policyTitle")}</h3>
        <div>
          <label htmlFor={`${id}-kind`} className={labelClass}>{t("kind")}</label>
          <select id={`${id}-kind`} value={kind} onChange={(e) => setKind(e.target.value as "percent" | "flat")} className={`${inputClass} min-h-11`}>
            <option value="percent">{t("kindPercent")}</option>
            <option value="flat">{t("kindFlat")}</option>
          </select>
        </div>
        {kind === "percent" ? (
          <div>
            <label htmlFor={`${id}-pct`} className={labelClass}>{t("percent")}</label>
            <input id={`${id}-pct`} name="percent" type="number" inputMode="decimal" min={0} max={30} step={0.01} defaultValue={policy.percent_bps === null ? "10" : String(policy.percent_bps / 100)} className={inputClass} aria-invalid={bad(pol.invalid, "percent_bps")} />
          </div>
        ) : (
          <div>
            <label htmlFor={`${id}-flat`} className={labelClass}>{t("flat")}</label>
            <input id={`${id}-flat`} name="flat" type="number" inputMode="decimal" min={0} step={0.01} defaultValue={rupeesOf(policy.flat_paise)} className={inputClass} aria-invalid={bad(pol.invalid, "flat_paise")} />
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor={`${id}-min`} className={labelClass}>{t("min")}</label>
            <input id={`${id}-min`} name="min" type="number" inputMode="decimal" min={0} step={0.01} defaultValue={rupeesOf(policy.min_paise)} className={inputClass} aria-invalid={bad(pol.invalid, "min_paise")} />
          </div>
          <div>
            <label htmlFor={`${id}-cap`} className={labelClass}>{t("cap")}</label>
            <input id={`${id}-cap`} name="cap" type="number" inputMode="decimal" min={0} step={0.01} defaultValue={rupeesOf(policy.cap_paise)} className={inputClass} aria-invalid={bad(pol.invalid, "cap_paise")} />
          </div>
        </div>
        <div>
          <label htmlFor={`${id}-waived`} className={labelClass}>{t("waivedUntil")}</label>
          <input id={`${id}-waived`} name="waived_until" type="date" defaultValue={policy.waived_until ?? ""} className={inputClass} />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={pol.busy}>{t("savePolicy")}</Button>
          {pol.feedback}
        </div>
      </form>
    </div>
  );
}

export function RetryButton({ itemId }: { itemId: string }) {
  const t = useT("payouts.admin");
  const { busy, run, feedback } = useSend();
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button type="button" className={secondaryButtonClass} disabled={busy} onClick={() => run(`/api/admin/payouts/items/${itemId}/retry`, "POST", undefined, { ok: t("retried"), fail: () => t("failedSave") })}>
        {t("retry")}
      </button>
      {feedback}
    </span>
  );
}
