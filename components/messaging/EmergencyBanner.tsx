"use client";

import { useT } from "@/lib/i18n/client";

// 027 FR-4 / D-5: shown on every messaging page, for guardians and providers.
export function EmergencyBanner() {
  const t = useT("messaging");
  return (
    <p role="note" className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm font-medium text-red-900" data-testid="emergency-banner">
      {t("emergency")}
    </p>
  );
}
