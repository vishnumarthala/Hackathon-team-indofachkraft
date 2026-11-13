"use client";

import { useEffect, useRef } from "react";
import { useT } from "@/lib/i18n/client";

// Ticket 033 FR-7: after a red flag this is the only content of the check-in: no band, no providers, no booking.
export function UrgentNotice() {
  const t = useT("screen");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="alert"
      data-testid="screen-urgent"
      className="rounded-2xl border-2 border-red-600 bg-red-50 p-5 text-lg font-semibold leading-relaxed text-red-900 focus:outline-none"
    >
      {t("urgent")}
    </div>
  );
}
