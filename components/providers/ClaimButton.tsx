"use client";

import { useState } from "react";
import { useT } from "@/lib/i18n/client";
import { buttonClass, send } from "./request";

export function ClaimButton({ token }: { token: string }) {
  const t = useT("providers.claim");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function claim() {
    setBusy(true);
    setError("");
    const res = await send(`/api/claims/${token}`, "POST");
    if (res.ok) {
      window.location.assign(String(res.json.redirect ?? "/dashboard/profile"));
      return;
    }
    setBusy(false);
    setError(res.status === 409 ? t("hasProfile") : res.status === 403 ? t("notAllowed") : t("invalid"));
  }

  return (
    <div className="space-y-2">
      <button type="button" disabled={busy} onClick={claim} className={buttonClass}>
        {busy ? t("claiming") : t("button")}
      </button>
      {error ? (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}
