"use client";

import { useState } from "react";
import { secondaryButtonClass, send } from "@/components/providers/request";
import { useT } from "@/lib/i18n/client";

// 045 FR-2: one-time notice after "pay at clinic" services were moved to payment on DoctorNearMe.
export function AtClinicNotice() {
  const t = useT("fees.notice");
  const [open, setOpen] = useState(true);
  if (!open) return null;
  return (
    <div role="status" className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950" data-testid="at-clinic-notice">
      <p className="max-w-prose">{t("atClinicRetired")}</p>
      <button
        type="button"
        className={secondaryButtonClass}
        onClick={async () => {
          setOpen(false);
          await send("/api/provider/services/notice", "POST");
        }}
      >
        {t("dismiss")}
      </button>
    </div>
  );
}
