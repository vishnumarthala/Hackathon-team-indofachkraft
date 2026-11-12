"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useFormatter, useT } from "@/lib/i18n/client";
import { buttonClass, inputClass, labelClass, secondaryButtonClass, send } from "./request";

// FR-4: approve / reject one submission. The note is required to reject, and to approve council OTHER.
export function ReviewActions({ submissionId, council }: { submissionId: string; council: string }) {
  const t = useT("providers.adminVerifications");
  const router = useRouter();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const noteForApproval = council === "OTHER";

  async function decide(action: "approve" | "reject") {
    if ((action === "reject" || noteForApproval) && !note.trim()) return setError(t("noteRequired"));
    setBusy(true);
    setError("");
    const res = await send(`/api/admin/verifications/${submissionId}`, "POST", { action, note });
    setBusy(false);
    if (!res.ok) return setError(res.status === 400 ? t("noteRequired") : t("failed"));
    router.refresh();
  }

  const noteId = `note-${submissionId}`;
  return (
    <div className="space-y-2">
      <label htmlFor={noteId} className={labelClass}>
        {t("note")}
      </label>
      <textarea id={noteId} rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} aria-describedby={`${noteId}-hint`} className={inputClass} />
      <p id={`${noteId}-hint`} className="text-xs text-slate-600">
        {noteForApproval ? t("noteHintOther") : t("noteHint")}
      </p>
      {error ? (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy} onClick={() => decide("approve")} className={buttonClass}>
          {t("approve")}
        </button>
        <button type="button" disabled={busy} onClick={() => decide("reject")} className={secondaryButtonClass}>
          {t("reject")}
        </button>
      </div>
    </div>
  );
}

export function ClaimLinkButton({ profileId }: { profileId: string }) {
  const t = useT("providers.adminProviders");
  const format = useFormatter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [link, setLink] = useState<{ url: string; expires_at: string } | null>(null);

  async function create() {
    setBusy(true);
    setError("");
    const res = await send(`/api/admin/providers/${profileId}/claim-link`, "POST");
    setBusy(false);
    if (!res.ok) return setError(t("failed"));
    setLink({ url: String(res.json.url), expires_at: String(res.json.expires_at) });
  }

  return (
    <div className="space-y-1">
      <button type="button" disabled={busy} onClick={create} className={secondaryButtonClass}>
        {t("claimLink")}
      </button>
      {link ? (
        <div className="space-y-1">
          <input readOnly aria-label={t("claimLinkLabel")} value={link.url} onFocus={(e) => e.currentTarget.select()} className={`${inputClass} min-w-64`} />
          <p className="text-xs text-slate-600">{t("claimLinkCreated", { date: format.dateTime(link.expires_at) })}</p>
        </div>
      ) : null}
      {error ? <p className="text-sm text-red-700">{error}</p> : null}
    </div>
  );
}

export function SuspendButton({ profileId }: { profileId: string }) {
  const t = useT("providers.adminProviders");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function suspend() {
    if (!note.trim() || !window.confirm(t("suspendConfirm"))) return;
    setBusy(true);
    setError("");
    const res = await send(`/api/admin/providers/${profileId}/suspend`, "POST", { note });
    setBusy(false);
    if (!res.ok) return setError(t("failed"));
    router.refresh();
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="min-h-11 text-sm font-medium text-red-700 underline">
        {t("suspend")}
      </button>
    );
  }
  const noteId = `suspend-${profileId}`;
  return (
    <div className="space-y-1">
      <label htmlFor={noteId} className={labelClass}>
        {t("suspendNote")}
      </label>
      <input id={noteId} required maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} className={inputClass} />
      <button type="button" disabled={busy || !note.trim()} onClick={suspend} className={secondaryButtonClass}>
        {t("suspend")}
      </button>
      {error ? <p className="text-sm text-red-700">{error}</p> : null}
    </div>
  );
}
