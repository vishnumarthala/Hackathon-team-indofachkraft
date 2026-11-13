"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { useT } from "@/lib/i18n/client";

// 041 FR-8: Approve / Reject (a rejection must cite the record-keeping obligation, at least 10 characters).
export function DeletionReviewForm({ requestId }: { requestId: string }) {
  const t = useT("privacy.admin.requests");
  const router = useRouter();
  const id = useId();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<"saved" | "failed" | "noteRequired" | null>(null);

  async function decide(decision: "approve" | "reject") {
    if (decision === "reject" && note.trim().length < 10) {
      setMessage("noteRequired");
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/admin/privacy/requests/${requestId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, ...(note.trim() ? { note: note.trim() } : {}) }),
      });
      setMessage(res.ok ? "saved" : "failed");
      if (res.ok) router.refresh();
    } catch {
      setMessage("failed");
    }
    setBusy(false);
  }

  return (
    <div className="space-y-2">
      <label htmlFor={`${id}-note`} className="block text-sm font-medium text-slate-800">
        {t("note")}
      </label>
      <textarea
        id={`${id}-note`}
        value={note}
        maxLength={1000}
        onChange={(e) => setNote(e.target.value)}
        className="min-h-16 w-full rounded border border-slate-300 px-2 py-1 text-sm"
      />
      <div className="flex flex-wrap gap-3">
        <button type="button" disabled={busy} onClick={() => decide("approve")} className="min-h-11 rounded bg-slate-900 px-4 font-semibold text-white disabled:opacity-60">
          {busy ? t("saving") : t("approve")}
        </button>
        <button type="button" disabled={busy} onClick={() => decide("reject")} className="min-h-11 rounded border border-slate-300 bg-white px-4 font-semibold text-slate-800 disabled:opacity-60">
          {t("reject")}
        </button>
      </div>
      {message ? (
        <p role={message === "saved" ? "status" : "alert"} className={message === "saved" ? "text-sm text-teal-800" : "text-sm text-red-700"}>
          {t(message)}
        </p>
      ) : null}
    </div>
  );
}
