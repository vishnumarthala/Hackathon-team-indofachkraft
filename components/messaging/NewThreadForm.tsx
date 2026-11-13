"use client";

import { useRouter } from "next/navigation";
import { useId, useRef, useState } from "react";
import { buttonClasses, type Tone } from "@/components/documents/styles";
import { useT } from "@/lib/i18n/client";
import { BODY_MAX, SUBJECT_MAX } from "@/lib/messaging/constants";
import { messagingErrorKey, newClientId, type MessagingErrorKey } from "./client";

export type CaseChoice = { id: string; label: string };

// 027 FR-4: start a conversation (subject + first message). Guardians pick the organisation (case) when the child
// has more than one; providers start it on the current case. On success the new thread opens.
export function NewThreadForm({ cases, hrefBase, tone, idPrefix }: { cases: CaseChoice[]; hrefBase: string; tone: Tone; idPrefix?: string }) {
  const t = useT("messaging");
  const router = useRouter();
  const classes = buttonClasses(tone);
  const base = `${idPrefix ?? ""}${useId()}`;
  const [open, setOpen] = useState(false);
  const [caseId, setCaseId] = useState(cases.length === 1 ? cases[0].id : "");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MessagingErrorKey | null>(null);
  const clientId = useRef(newClientId());

  if (!open) {
    return (
      <button type="button" className={classes.primary} onClick={() => setOpen(true)}>
        {t("newThread")}
      </button>
    );
  }

  async function submit() {
    if (!caseId) return setError("chooseCase");
    if (!subject.trim()) return setError("subjectRequired");
    if (!body.trim()) return setError("bodyRequired");
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ case_id: caseId, subject, body, client_id: clientId.current }),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        return setError(messagingErrorKey(res.status, payload.error));
      }
      const { thread } = (await res.json()) as { thread: { id: string } };
      router.push(`${hrefBase}/${thread.id}`);
    } catch {
      setError("failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4"
      aria-label={t("newThread")}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {cases.length > 1 ? (
        <div className="space-y-1">
          <label htmlFor={`${base}-to`} className="block text-sm font-medium text-slate-900">
            {t("to")}
          </label>
          <select
            id={`${base}-to`}
            value={caseId}
            onChange={(e) => setCaseId(e.target.value)}
            className="min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-base sm:w-auto"
          >
            <option value="">{t("errors.chooseCase")}</option>
            {cases.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
      ) : cases[0]?.label ? (
        <p className="text-sm text-slate-700">
          {t("to")}: <span className="font-semibold">{cases[0].label}</span>
        </p>
      ) : null}
      <div className="space-y-1">
        <label htmlFor={`${base}-subject`} className="block text-sm font-medium text-slate-900">
          {t("subject")}
        </label>
        <input
          id={`${base}-subject`}
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          maxLength={SUBJECT_MAX}
          aria-describedby={`${base}-subject-hint`}
          className="min-h-11 w-full rounded-lg border border-slate-300 px-3 text-base"
        />
        <p id={`${base}-subject-hint`} className="text-xs text-slate-600">
          {t("subjectHint")}
        </p>
      </div>
      <div className="space-y-1">
        <label htmlFor={`${base}-body`} className="block text-sm font-medium text-slate-900">
          {t("body")}
        </label>
        <textarea
          id={`${base}-body`}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={4}
          maxLength={BODY_MAX}
          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-base"
        />
      </div>
      {error ? (
        <p role="alert" className="text-sm font-medium text-red-700">
          {t(`errors.${error}`)}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-3">
        <button type="submit" className={classes.primary} disabled={busy}>
          {busy ? t("sending") : t("send")}
        </button>
        <button type="button" className={classes.secondary} onClick={() => setOpen(false)}>
          {t("cancel")}
        </button>
      </div>
    </form>
  );
}
