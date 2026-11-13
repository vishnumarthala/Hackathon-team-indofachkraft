"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { buttonClass, inputClass, labelClass, secondaryButtonClass, send } from "@/components/providers/request";
import { useT } from "@/lib/i18n/client";

/** 036 FR-6 `Report a rating`: a short reason, then the rating leaves the profile until an admin decides. */
export function ReportRatingButton({ ratingId }: { ratingId: string }) {
  const t = useT("ratings.provider");
  const router = useRouter();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<"reasonRequired" | "reportFailed" | null>(null);

  async function report(event: React.FormEvent) {
    event.preventDefault();
    if (reason.trim().length < 3) return setError("reasonRequired");
    setBusy(true);
    setError(null);
    const res = await send(`/api/ratings/${ratingId}/report`, "POST", { reason: reason.trim() });
    setBusy(false);
    if (!res.ok) return setError("reportFailed");
    setOpen(false);
    router.refresh();
  }

  if (!open) {
    return (
      <button type="button" className={secondaryButtonClass} onClick={() => setOpen(true)}>
        {t("report")}
      </button>
    );
  }
  return (
    <form onSubmit={report} className="space-y-2 rounded border border-slate-200 bg-slate-50 p-3">
      <label htmlFor={`${id}-reason`} className={labelClass}>
        {t("reportReason")}
      </label>
      <textarea
        id={`${id}-reason`}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        maxLength={500}
        rows={3}
        aria-invalid={error === "reasonRequired"}
        className={inputClass}
      />
      {error ? (
        <p role="alert" className="text-sm text-red-800">
          {t(error)}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={busy} className={buttonClass}>
          {t("sendReport")}
        </button>
        <button type="button" disabled={busy} onClick={() => setOpen(false)} className={secondaryButtonClass}>
          {t("cancel")}
        </button>
      </div>
    </form>
  );
}
