"use client";

import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { fieldKeys, inputClass, labelClass, secondaryButtonClass, send } from "@/components/providers/request";
import { useT } from "@/lib/i18n/client";
import { Button } from "@/components/ui/Button";

type Pkg = { id: string; name: string; active: boolean; summary: string };

// 045 FR-7: add packages and stop / restart offering them (offers already made keep their snapshot).
export function PackagesEditor({ orgId, services, packages }: { orgId: string; services: { id: string; label: string }[]; packages: Pkg[] }) {
  const t = useT("fees.settings");
  const te = useT("fees.caseTab.errors");
  const router = useRouter();
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [invalid, setInvalid] = useState<string[]>([]);

  async function call(url: string, method: string, body: unknown): Promise<boolean> {
    setBusy(true);
    setMessage(null);
    const res = await send(url, method, body);
    setBusy(false);
    setInvalid(fieldKeys(res.json));
    if (!res.ok) {
      const code = res.json.code;
      // 046 FR-2 / FR-8: packages need an active payout account and the accepted platform fee.
      const payout = code === "payout_account_inactive" || code === "fee_policy_not_accepted" ? te(code) : null;
      setMessage({ ok: false, text: payout ?? (res.status === 403 ? te("forbidden") : res.status === 400 ? te("invalid") : te("generic")) });
      return false;
    }
    setMessage({ ok: true, text: t("saved") });
    router.refresh();
    return true;
  }

  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const ok = await call(`/api/orgs/${orgId}/packages`, "POST", {
      name: String(f.get("name") ?? ""),
      session_count: Number(f.get("session_count")),
      price_inr: Number(f.get("price_inr")),
      validity_days: Number(f.get("validity_days")),
      service_ids: f.getAll("service_ids").map(String),
      active: true,
    });
    if (ok) form.reset();
  }

  const bad = (field: string) => invalid.includes(field) || undefined;

  return (
    <div className="space-y-4">
      {packages.length === 0 ? (
        <p className="text-sm text-slate-600">{t("none")}</p>
      ) : (
        <ul className="space-y-2" data-testid="packages-list">
          {packages.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-slate-200 bg-white p-3 text-sm">
              <span className={p.active ? "text-slate-900" : "text-slate-500"}>
                <span className="font-medium">{p.name}</span> · {p.summary}
                {p.active ? "" : ` · ${t("inactive")}`}
              </span>
              <button type="button" className={secondaryButtonClass} disabled={busy} onClick={() => call(`/api/orgs/${orgId}/packages/${p.id}`, "PATCH", { active: !p.active })}>
                {p.active ? t("retire") : t("reactivate")}
              </button>
            </li>
          ))}
        </ul>
      )}
      {services.length === 0 ? (
        <p className="text-sm text-slate-700">{t("noServices")}</p>
      ) : (
        <form onSubmit={add} className="grid gap-3 rounded border border-slate-200 bg-slate-50 p-3 sm:grid-cols-2" aria-label={t("add")}>
          <div className="sm:col-span-2">
            <label htmlFor={`${id}-name`} className={labelClass}>
              {t("name")}
            </label>
            <input id={`${id}-name`} name="name" required maxLength={80} className={inputClass} aria-invalid={bad("name")} />
          </div>
          <div>
            <label htmlFor={`${id}-n`} className={labelClass}>
              {t("sessions")}
            </label>
            <input id={`${id}-n`} name="session_count" type="number" min={1} max={60} defaultValue={12} required className={inputClass} aria-invalid={bad("session_count")} />
          </div>
          <div>
            <label htmlFor={`${id}-price`} className={labelClass}>
              {t("price")}
            </label>
            <input id={`${id}-price`} name="price_inr" type="number" min={1} max={100000} defaultValue={9000} required className={inputClass} aria-invalid={bad("price_inr")} />
          </div>
          <div>
            <label htmlFor={`${id}-days`} className={labelClass}>
              {t("validity")}
            </label>
            <input id={`${id}-days`} name="validity_days" type="number" min={7} max={180} defaultValue={30} required className={inputClass} aria-invalid={bad("validity_days")} />
          </div>
          <fieldset className="sm:col-span-2" aria-invalid={bad("service_ids")}>
            <legend className={labelClass}>{t("services")}</legend>
            <div className="mt-1 space-y-1">
              {services.map((s) => (
                <label key={s.id} className="flex min-h-11 items-center gap-2 text-sm text-slate-900">
                  <input type="checkbox" name="service_ids" value={s.id} className="h-5 w-5" />
                  {s.label}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
            <Button type="submit" disabled={busy}>
              {t("add")}
            </Button>
            {message ? (
              <p role={message.ok ? "status" : "alert"} className={message.ok ? "text-sm text-teal-900" : "text-sm text-red-800"}>
                {message.text}
              </p>
            ) : null}
          </div>
        </form>
      )}
    </div>
  );
}
