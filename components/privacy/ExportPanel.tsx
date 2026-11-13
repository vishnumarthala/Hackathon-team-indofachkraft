"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { primaryButtonClass } from "@/components/family/PhoneOtpForm";
import { useFormatter, useT } from "@/lib/i18n/client";

export type ExportView = {
  id: string;
  status: "queued" | "building" | "ready" | "failed" | "expired";
  createdAt: string;
  expiresAt: string | null;
};

type Message = "exportRequested" | "exportRunning" | "exportLimitReached" | "exportFailedRequest";

// 041 FR-7: `Download <child>'s data` + the guardian's own exports (newest first).
export function ExportPanel({ childId, name, exports }: { childId: string; name: string; exports: ExportView[] }) {
  const t = useT("privacy.family");
  const format = useFormatter();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);

  async function request() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/family/children/${childId}/exports`, { method: "POST" });
      if (res.status === 202) setMessage("exportRequested");
      else if (res.status === 429) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setMessage(body?.error?.startsWith("An export") ? "exportRunning" : "exportLimitReached");
      } else setMessage("exportFailedRequest");
      router.refresh();
    } catch {
      setMessage("exportFailedRequest");
    }
    setBusy(false);
  }

  const ok = message === "exportRequested";
  return (
    <section aria-labelledby="export-heading" className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4">
      <h2 id="export-heading" className="text-xl font-semibold text-slate-900">
        {t("exportTitle")}
      </h2>
      <p className="text-slate-700">{t("exportIntro", { name })}</p>
      <p className="text-sm text-slate-600">{t("exportLimit")}</p>
      <button type="button" className={primaryButtonClass} onClick={request} disabled={busy}>
        {busy ? t("exportRequesting") : t("exportButton", { name })}
      </button>
      {message ? (
        <p
          role={ok ? "status" : "alert"}
          className={`rounded-xl px-4 py-3 text-sm font-medium ${ok ? "bg-teal-50 text-teal-900" : "bg-red-50 text-red-700"}`}
        >
          {t(message)}
        </p>
      ) : null}
      {exports.length > 0 ? (
        <div className="space-y-2">
          <h3 className="font-semibold text-slate-900">{t("exportsListTitle")}</h3>
          <ul className="space-y-2" data-testid="exports-list">
            {exports.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-slate-50 px-3 py-2">
                <span className="text-sm text-slate-700">
                  <span className="font-semibold text-slate-900">{t(`exportStatus.${e.status}`)}</span>
                  {" · "}
                  {t("requestedOn", { date: format.dateTime(e.createdAt) })}
                  {e.status === "ready" && e.expiresAt ? ` · ${t("availableUntil", { date: format.date(e.expiresAt, "long") })}` : ""}
                </span>
                {e.status === "ready" ? (
                  <a
                    href={`/api/family/exports/${e.id}/download`}
                    className="inline-flex min-h-11 items-center font-semibold text-teal-800 underline"
                  >
                    {t("download")}
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
