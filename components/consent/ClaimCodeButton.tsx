"use client";

import { useState } from "react";
import { useFormatter, useT } from "@/lib/i18n/client";

type Created = { code: string; expires_at: string; whatsapp_url: string };

const buttonClass =
  "inline-flex min-h-11 items-center rounded px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60";

// 020 FR-12/FR-14: creates a one-time parent code; it is shown only here, once.
export function ClaimCodeButton({ caseId }: { caseId: string }) {
  const t = useT("consentPanel");
  const format = useFormatter();
  const [created, setCreated] = useState<Created | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function create() {
    setBusy(true);
    setFailed(false);
    try {
      const res = await fetch(`/api/cases/${caseId}/claim-code`, { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as Partial<Created>;
      if (res.status !== 201 || !body.code || !body.expires_at || !body.whatsapp_url) throw new Error(String(res.status));
      setCreated(body as Created);
    } catch {
      setFailed(true);
    }
    setBusy(false);
  }

  return (
    <div className="space-y-2">
      <button type="button" onClick={create} disabled={busy} className={`${buttonClass} bg-slate-900 text-white`}>
        {busy ? t("creating") : t("createCode")}
      </button>
      {failed ? (
        <p role="alert" className="text-sm text-red-700">
          {t("codeFailed")}
        </p>
      ) : null}
      {created ? (
        <div role="status" className="space-y-2 rounded border border-emerald-200 bg-emerald-50 p-3">
          <p className="text-sm text-emerald-950">{t("codeLabel")}</p>
          <p className="font-mono text-2xl font-semibold tracking-widest text-emerald-950" data-testid="claim-code">
            {created.code}
          </p>
          <p className="text-sm text-emerald-950">{t("codeExpires", { date: format.dateTime(created.expires_at) })}</p>
          <a
            href={created.whatsapp_url}
            target="_blank"
            rel="noopener noreferrer"
            className={`${buttonClass} bg-emerald-600 text-white`}
          >
            {t("shareWhatsapp")}
          </a>
        </div>
      ) : null}
    </div>
  );
}
