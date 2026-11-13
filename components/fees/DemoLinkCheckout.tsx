"use client";

import { useState } from "react";
import { buttonClass, secondaryButtonClass, send } from "@/components/providers/request";
import { useT } from "@/lib/i18n/client";

// 045 DEMO_MODE: simulates the payer on Razorpay's page. Success follows the signed redirect the server returns (the
// same /api/payments/links/callback a real payment uses); failure leaves the link open.
export function DemoLinkCheckout({ linkId }: { linkId: string }) {
  const t = useT("fees.pay");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function pay(outcome: "success" | "failure") {
    setBusy(true);
    setFailed(false);
    const res = await send("/api/payments/links/demo", "POST", { link_id: linkId, outcome });
    if (outcome === "success" && res.ok && typeof res.json.callback_url === "string") {
      window.location.assign(res.json.callback_url);
      return;
    }
    setBusy(false);
    setFailed(true);
  }

  return (
    <div className="space-y-3">
      <button type="button" className={`${buttonClass} w-full`} disabled={busy} onClick={() => pay("success")} data-testid="demo-pay-success">
        {busy ? t("working") : t("success")}
      </button>
      <button type="button" className={`${secondaryButtonClass} w-full`} disabled={busy} onClick={() => pay("failure")}>
        {t("failure")}
      </button>
      {failed ? (
        <p role="alert" className="text-sm text-red-800">
          {t("failed")}
        </p>
      ) : null}
    </div>
  );
}
