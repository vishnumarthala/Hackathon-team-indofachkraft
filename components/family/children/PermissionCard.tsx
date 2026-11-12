"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { primaryButtonClass, secondaryButtonClass } from "@/components/family/PhoneOtpForm";
import type { ConsentFeature } from "@/lib/consent/features";
import { useFormatter, useT } from "@/lib/i18n/client";

export type PermissionView = {
  feature: ConsentFeature;
  name: string;
  description: string;
  document: {
    id: string;
    title: string;
    version: number;
    body: string;
    processors: { name: string; purpose: string; location: string }[];
  } | null;
  granted: boolean;
  method: "digital" | "paper" | null;
  paperSignedOn: string | null;
};

type ErrorKey = "verifyPhone" | "outdated" | "saveFailed";

/** Maps API answers (English contract) to translated messages. */
export function permissionErrorKey(status: number): ErrorKey {
  if (status === 422) return "verifyPhone";
  if (status === 409) return "outdated";
  return "saveFailed";
}

/** Date-only values (YYYY-MM-DD) are formatted at noon UTC so the calendar day is stable in every zone. */
export const dateOnly = (value: string) => `${value}T12:00:00Z`;

// 020 FR-13 / FR-18d: one feature: plain-language description, status, processors, full text, Allow/Withdraw.
export function PermissionCard({ childId, view, phoneVerified }: { childId: string; view: PermissionView; phoneVerified: boolean }) {
  const t = useT("family.children.overview");
  const tc = useT("consent");
  const format = useFormatter();
  const router = useRouter();
  const id = useId();
  const [agree, setAgree] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ErrorKey | null>(null);

  async function send(url: string, body?: unknown) {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!res.ok) setError(permissionErrorKey(res.status));
      else {
        setAgree(false);
        router.refresh();
      }
    } catch {
      setError("saveFailed");
    }
    setSaving(false);
  }

  const allow = () =>
    view.document &&
    send(`/api/family/children/${childId}/consents`, {
      feature: view.feature,
      consent_document_id: view.document.id,
      agree: true,
    });
  const withdraw = () => send(`/api/family/children/${childId}/consents/${view.feature}/withdraw`);

  return (
    <li className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4" data-feature={view.feature}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 className="text-lg font-semibold break-words text-slate-900">{view.name}</h3>
        <span
          className={`rounded-full px-3 py-1 text-sm font-semibold ${
            view.granted ? "bg-teal-100 text-teal-900" : "bg-slate-100 text-slate-700"
          }`}
          data-testid={`status-${view.feature}`}
        >
          {view.granted ? tc("allowed") : tc("notAllowed")}
        </span>
      </div>
      {view.granted && view.method === "paper" && view.paperSignedOn ? (
        <p className="text-sm font-medium text-slate-700">{tc("onPaper", { date: format.date(dateOnly(view.paperSignedOn), "long") })}</p>
      ) : null}
      <p className="text-slate-700">{view.description}</p>
      {view.document ? (
        <>
          <div>
            <h4 className="text-sm font-semibold text-slate-900">{tc("processors")}</h4>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-slate-700">
              {view.document.processors.map((p) => (
                <li key={`${p.name}-${p.purpose}`}>{tc("processor", p)}</li>
              ))}
            </ul>
          </div>
          <details className="rounded-xl bg-slate-50 p-3">
            <summary className="min-h-11 cursor-pointer py-2 font-semibold text-teal-800">{tc("readFull")}</summary>
            <h4 className="mt-2 font-semibold text-slate-900">{view.document.title}</h4>
            <p className="mt-2 text-sm whitespace-pre-line text-slate-800">{view.document.body.replace(/\*\*/g, "")}</p>
            <p className="mt-2 text-xs text-slate-500">{tc("version", { version: view.document.version })}</p>
          </details>
        </>
      ) : null}
      {error ? (
        <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
          {t(error)}
          {error === "verifyPhone" ? (
            <>
              {" "}
              <Link href="/family/settings" className="underline">
                {t("verifyLink")}
              </Link>
            </>
          ) : null}
        </p>
      ) : null}
      {view.granted ? (
        <button type="button" className={secondaryButtonClass} onClick={withdraw} disabled={saving}>
          {saving ? t("saving") : t("withdraw")}
        </button>
      ) : (
        <div className="space-y-3">
          {!phoneVerified ? (
            <p className="text-sm text-slate-700">
              {t("verifyPhone")}{" "}
              <Link href="/family/settings" className="font-semibold text-teal-800 underline">
                {t("verifyLink")}
              </Link>
            </p>
          ) : null}
          <div className="flex items-start gap-3">
            <input
              id={`${id}-agree`}
              type="checkbox"
              className="mt-1 h-5 w-5 shrink-0"
              checked={agree}
              onChange={(e) => setAgree(e.target.checked)}
              disabled={!view.document}
            />
            <label htmlFor={`${id}-agree`} className="text-sm text-slate-900">
              {t("agree")}
            </label>
          </div>
          <button
            type="button"
            className={`${primaryButtonClass} sm:w-auto`}
            onClick={allow}
            disabled={saving || !agree || !view.document}
          >
            {saving ? t("saving") : t("allow")}
          </button>
        </div>
      )}
    </li>
  );
}
