"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { secondaryButtonClass } from "@/components/family/PhoneOtpForm";
import { useFormatter, useT } from "@/lib/i18n/client";

export type DeletionView = {
  id: string;
  scope: "all_ai_processing" | "everything";
  status: "requested" | "approved" | "rejected" | "in_progress" | "completed" | "failed";
  createdAt: string;
  reviewNote: string | null;
};

type Message = "deleteSent" | "deleteOpen" | "deleteFailed" | "chooseScope";
const SCOPES = ["all_ai_processing", "everything"] as const;

// 041 FR-8: the guardian asks for AI processing to stop, or for everything to be deleted. A platform admin reviews it.
export function DeletionRequestForm({ childId, name, requests }: { childId: string; name: string; requests: DeletionView[] }) {
  const t = useT("privacy.family");
  const format = useFormatter();
  const router = useRouter();
  const id = useId();
  const [scope, setScope] = useState<(typeof SCOPES)[number] | null>(null);
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const open = requests.some((r) => ["requested", "approved", "in_progress", "failed"].includes(r.status));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!scope) {
      setMessage("chooseScope");
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/family/children/${childId}/deletion-requests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope, ...(reason.trim() ? { reason: reason.trim() } : {}) }),
      });
      setMessage(res.status === 201 ? "deleteSent" : res.status === 409 ? "deleteOpen" : "deleteFailed");
      if (res.status === 201) {
        setScope(null);
        setReason("");
        setConfirmed(false);
      }
      router.refresh();
    } catch {
      setMessage("deleteFailed");
    }
    setBusy(false);
  }

  return (
    <section aria-labelledby="delete-heading" className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4">
      <h2 id="delete-heading" className="text-xl font-semibold text-slate-900">
        {t("deleteTitle")}
      </h2>
      <p className="text-slate-700">{t("deleteIntro")}</p>
      {requests.length > 0 ? (
        <div className="space-y-2">
          <h3 className="font-semibold text-slate-900">{t("requestsTitle")}</h3>
          <ul className="space-y-2" data-testid="deletion-requests">
            {requests.map((r) => (
              <li key={r.id} className="rounded-xl bg-slate-50 px-3 py-2 text-sm text-slate-700">
                <span className="font-semibold text-slate-900">{t(`requestStatus.${r.status}`)}</span>
                {" · "}
                {t(`scope.${r.scope}.label`, { name })}
                {" · "}
                {t("requestedOn", { date: format.dateTime(r.createdAt) })}
                {r.status === "rejected" && r.reviewNote ? <p className="mt-1">{t("rejectedReason", { note: r.reviewNote })}</p> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {open ? null : (
        <form onSubmit={submit} className="space-y-3" noValidate>
          <fieldset className="space-y-2">
            <legend className="sr-only">{t("chooseScope")}</legend>
            {SCOPES.map((s) => (
              <label key={s} className="flex gap-3 rounded-xl border border-slate-200 p-3">
                <input
                  type="radio"
                  name={`${id}-scope`}
                  value={s}
                  checked={scope === s}
                  onChange={() => setScope(s)}
                  className="mt-1 h-5 w-5"
                />
                <span>
                  <span className="block font-semibold text-slate-900">{t(`scope.${s}.label`, { name })}</span>
                  <span className="block text-sm text-slate-700">{t(`scope.${s}.description`)}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <div className="space-y-1">
            <label htmlFor={`${id}-reason`} className="block text-sm font-semibold text-slate-900">
              {t("reasonLabel")}
            </label>
            <textarea
              id={`${id}-reason`}
              value={reason}
              maxLength={1000}
              onChange={(e) => setReason(e.target.value)}
              className="min-h-20 w-full rounded-xl border border-slate-300 px-3 py-2"
            />
          </div>
          <label className="flex items-start gap-3 text-sm text-slate-800">
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="mt-0.5 h-5 w-5" />
            {t("confirmLabel")}
          </label>
          <button type="submit" className={secondaryButtonClass} disabled={busy || !confirmed}>
            {busy ? t("deleteSending") : t("deleteButton")}
          </button>
        </form>
      )}
      {message ? (
        <p
          role={message === "deleteSent" ? "status" : "alert"}
          className={`rounded-xl px-4 py-3 text-sm font-medium ${message === "deleteSent" ? "bg-teal-50 text-teal-900" : "bg-red-50 text-red-700"}`}
        >
          {t(message)}
        </p>
      ) : null}
    </section>
  );
}
