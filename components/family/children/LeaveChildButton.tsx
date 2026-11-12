"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { secondaryButtonClass } from "@/components/family/PhoneOtpForm";
import { useT } from "@/lib/i18n/client";

// 020 FR-16: the guardian removes the child from their account (link revoked).
export function LeaveChildButton({ childId, name }: { childId: string; name: string }) {
  const t = useT("family.children.overview");
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function leave() {
    if (!window.confirm(t("leaveConfirm", { name }))) return;
    setBusy(true);
    setFailed(false);
    try {
      const res = await fetch(`/api/family/children/${childId}/leave`, { method: "POST" });
      if (!res.ok) throw new Error(String(res.status));
      router.replace("/family/children");
      router.refresh();
    } catch {
      setFailed(true);
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      {failed ? (
        <p role="alert" className="text-sm font-medium text-red-700">
          {t("saveFailed")}
        </p>
      ) : null}
      <button type="button" className={secondaryButtonClass} onClick={leave} disabled={busy}>
        {busy ? t("leaving") : t("leave")}
      </button>
    </div>
  );
}
