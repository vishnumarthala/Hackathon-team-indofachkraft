"use client";

import { useState } from "react";
import { useT } from "@/lib/i18n/client";
import { postFollowUp } from "@/lib/screen/client";
import type { ScreenQuestion, ScreenResult } from "@/lib/screen/questions";
import { primaryButton, secondaryButton } from "./view";

// Ticket 048 FR-3: the optional M-CHAT-R/F Follow-Up (moderate results only, MCHAT_LICENSED): one pass/fail question
// per item that scored. Sent in one request; the result above is replaced by the updated one.
export function FollowUp({
  sessionId,
  questions,
  onResult,
  onExpired,
}: {
  sessionId: string;
  questions: ScreenQuestion[];
  onResult: (result: ScreenResult) => void;
  onExpired: () => void;
}) {
  const t = useT("screen.result.mchat");
  const ts = useT("screen");
  const [open, setOpen] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<"missing" | "failed" | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    const done = await postFollowUp(fetch, sessionId, Object.entries(answers).map(([item_id, answer]) => ({ item_id, answer })));
    setBusy(false);
    if (done.ok) return onResult(done.result);
    if (done.status === 404 || done.status === 410) return onExpired();
    setError(done.status === 422 ? "missing" : "failed");
  }

  return (
    <section aria-labelledby="screen-followup-title" className="space-y-3 rounded-2xl border border-sky-200 bg-sky-50 p-4 sm:p-6" data-testid="screen-followup">
      <h2 id="screen-followup-title" className="text-xl font-semibold text-slate-900">
        {t("followUpTitle")}
      </h2>
      <p className="text-slate-800">{t("followUpIntro")}</p>
      {!open ? (
        <button type="button" className={secondaryButton} onClick={() => setOpen(true)}>
          {t("followUpStart")}
        </button>
      ) : (
        <div className="space-y-4">
          {questions.map((q) => (
            <fieldset key={q.id} className="space-y-2 rounded-xl bg-white p-3" data-item={q.id}>
              <legend lang="en" className="px-1 font-medium text-slate-900">
                {q.text}
              </legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {q.answers.map((value) => (
                  <label
                    key={value}
                    className={`flex min-h-12 cursor-pointer items-center gap-3 rounded-xl border px-4 py-2 ${
                      answers[q.id] === value ? "border-teal-700 bg-teal-50 font-semibold text-teal-900" : "border-slate-300 text-slate-800"
                    }`}
                  >
                    <input
                      type="radio"
                      name={`followup-${q.id}`}
                      value={value}
                      checked={answers[q.id] === value}
                      onChange={() => setAnswers((a) => ({ ...a, [q.id]: value }))}
                      className="h-5 w-5"
                    />
                    {value === "pass" ? t("pass") : t("fail")}
                  </label>
                ))}
              </div>
            </fieldset>
          ))}
          {error ? (
            <p role="alert" className="text-sm font-medium text-red-700">
              {error === "missing" ? t("missing") : ts("errors.failed")}
            </p>
          ) : null}
          <button
            type="button"
            className={primaryButton}
            disabled={busy || questions.some((q) => !answers[q.id])}
            onClick={submit}
          >
            {busy ? t("saving") : t("submit")}
          </button>
        </div>
      )}
    </section>
  );
}
