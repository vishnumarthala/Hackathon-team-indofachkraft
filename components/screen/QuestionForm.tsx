"use client";

import { useState } from "react";
import { useT } from "@/lib/i18n/client";
import { finishScreen, postAnswers } from "@/lib/screen/client";
import type { ScreenQuestion, ScreenResult } from "@/lib/screen/questions";
import { isAnswerKey, primaryButton, smallButton } from "./view";

type Props = {
  sessionId: string;
  questions: ScreenQuestion[];
  initialAnswers: Record<string, string>;
  onStop: () => void;
  onResult: (result: ScreenResult) => void;
  onExpired: () => void;
};

// Ticket 033 FR-2 / NFR-3: the tap-through version of the same questions (no microphone needed), one question per
// screen, red-flag questions first. Each answer is saved at once; a red-flag `yes` stops the check-in immediately.
export function QuestionForm({ sessionId, questions, initialAnswers, onStop, onResult, onExpired }: Props) {
  const t = useT("screen");
  const ta = useT("assessments.answers");
  const firstOpen = questions.findIndex((q) => !initialAnswers[q.id]);
  const [index, setIndex] = useState(firstOpen === -1 ? questions.length - 1 : firstOpen);
  const [answers, setAnswers] = useState<Record<string, string>>(initialAnswers);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<"missing" | "failed" | null>(null);

  const item = questions[index];
  const safetyCount = questions.filter((q) => q.kind === "red_flag").length;
  const isLast = index === questions.length - 1;
  const label = (value: string) => (isAnswerKey(value) ? ta(value) : value);

  async function choose(value: string) {
    setError(null);
    setAnswers((a) => ({ ...a, [item.id]: value }));
    // FR-7: safety first, the network second.
    if (item.kind === "red_flag" && value === "yes") onStop();
    setBusy(true);
    const saved = await postAnswers(fetch, sessionId, [{ item_id: item.id, answer: value }]);
    setBusy(false);
    if (!saved.ok) {
      if (saved.status === 410 || saved.status === 404) return onExpired();
      if (saved.status === 409 && saved.error === "This check-in was stopped") return onStop();
      setError("failed");
      return;
    }
    if (saved.stop) onStop();
  }

  async function finish() {
    setBusy(true);
    setError(null);
    const done = await finishScreen(fetch, sessionId);
    setBusy(false);
    if (done.ok) return done.result.red_flag ? onStop() : onResult(done.result);
    if (done.status === 410 || done.status === 404) return onExpired();
    if (done.status === 422 && done.missing.length) {
      setError("missing");
      const first = questions.findIndex((q) => done.missing.includes(q.id));
      if (first >= 0) setIndex(first);
      return;
    }
    setError("failed");
  }

  const legend =
    item.kind === "red_flag"
      ? t("form.safetyQuestion", { n: index + 1, total: safetyCount })
      : t("form.questionOf", { n: index + 1 - safetyCount, total: questions.length - safetyCount });

  return (
    <div className="space-y-5">
      <p className="text-sm text-slate-600">{t("englishOnly")}</p>
      <fieldset className="space-y-4 rounded-2xl border border-slate-200 bg-white p-4 sm:p-6" data-item={item.id}>
        <legend className="px-1 text-sm font-medium text-slate-600">{legend}</legend>
        <p lang="en" className="text-lg font-semibold text-slate-900">
          {item.text}
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          {item.answers.map((value) => {
            const checked = answers[item.id] === value;
            return (
              <label
                key={value}
                className={`flex min-h-12 cursor-pointer items-center gap-3 rounded-xl border px-4 py-2 text-base ${
                  checked ? "border-teal-700 bg-teal-50 font-semibold text-teal-900" : "border-slate-300 text-slate-800"
                }`}
              >
                <input
                  type="radio"
                  name={`answer-${item.id}`}
                  value={value}
                  checked={checked}
                  onChange={() => choose(value)}
                  className="h-5 w-5"
                />
                {label(value)}
              </label>
            );
          })}
        </div>
      </fieldset>

      {error ? (
        <p role="alert" className="text-sm font-medium text-red-700">
          {error === "missing" ? t("form.missing") : t("errors.failed")}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className={smallButton} disabled={index === 0 || busy} onClick={() => setIndex((i) => Math.max(0, i - 1))}>
          {t("form.back")}
        </button>
        {isLast ? (
          <button type="button" className={primaryButton} disabled={busy || !answers[item.id]} onClick={finish}>
            {busy ? t("form.saving") : t("form.finish")}
          </button>
        ) : (
          <button
            type="button"
            className={smallButton}
            disabled={busy || !answers[item.id]}
            onClick={() => setIndex((i) => Math.min(questions.length - 1, i + 1))}
          >
            {t("form.next")}
          </button>
        )}
      </div>
    </div>
  );
}
