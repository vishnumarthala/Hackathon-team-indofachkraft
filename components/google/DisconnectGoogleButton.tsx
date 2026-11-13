"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { secondaryButtonClass, send } from "@/components/providers/request";
import { useT } from "@/lib/i18n/client";

/** 037 FR-2 `Disconnect` with an inline confirmation. */
export function DisconnectGoogleButton() {
  const t = useT("integrations.google");
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function disconnect() {
    setBusy(true);
    setFailed(false);
    const res = await send("/api/integrations/google/disconnect", "POST");
    setBusy(false);
    if (res.ok || res.status === 404) {
      router.replace(`/dashboard/settings/integrations?disconnected=${res.json.revoked === false ? "unrevoked" : "1"}`);
      router.refresh();
      return;
    }
    setFailed(true);
  }

  if (!asking) {
    return (
      <button type="button" className={secondaryButtonClass} onClick={() => setAsking(true)}>
        {t("disconnect")}
      </button>
    );
  }
  return (
    <div className="flex w-full flex-wrap items-center gap-2 rounded border border-red-200 bg-red-50 p-3" role="group">
      <p className="w-full text-sm text-red-900">{t("disconnectQuestion")}</p>
      <button type="button" disabled={busy} onClick={disconnect} className="inline-flex min-h-11 items-center rounded bg-red-700 px-4 text-sm font-medium text-white disabled:opacity-50">
        {busy ? t("disconnecting") : t("disconnect")}
      </button>
      <button type="button" disabled={busy} onClick={() => setAsking(false)} className={secondaryButtonClass}>
        {t("keep")}
      </button>
      {failed ? <p role="alert" className="w-full text-sm text-red-800">{t("errors.generic")}</p> : null}
    </div>
  );
}
