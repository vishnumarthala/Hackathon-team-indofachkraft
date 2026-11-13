"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { useT } from "@/lib/i18n/client";
import { assessmentErrorKey, isAnswerKey, type ApiErrorKey } from "./view";

export type FormItem = { id: string; text: string; options: string[]; redFlag: boolean };
type Answers = Record<string, string>;

type SaveOutcome = { ok: true; version: number } | { ok: false; error: ApiErrorKey; missing?: string[] };

/** PUT /api/family/assessments/:id/responses. Pure apart from `fetchImpl` (unit tested). */
export async function saveAnswers(
  fetchImpl: typeof fetch,
  assessmentId: string,
  answers: Answers,
  version: number,
): Promise<SaveOutcome> {
  try {
    const res = await fetchImpl(`/api/family/assessments/${assessmentId}/responses`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answers: Object.entries(answers).map(([item_id, value]) => ({ item_id, value })), version }),
    });
    const json = (await res.json().catch(() => ({}))) as { version?: number; error?: string };
    if (!res.ok) return { ok: false, error: assessmentErrorKey(json.error) };
    return { ok: true, version: json.version ?? version + 1 };
  } catch {
    return { ok: false, error: "saveFailed" };
  }
}

/** POST /api/family/assessments/:id/submit. */
export async function submitAnswers(fetchImpl: typeof fetch, assessmentId: string): Promise<SaveOutcome> {
  try {
    const res = await fetchImpl(`/api/family/assessments/${assessmentId}/submit`, { method: "POST" });
    const json = (await res.json().catch(() => ({}))) as { error?: string; details?: { missing?: string[] } };
    if (!res.ok) return { ok: false, error: assessmentErrorKey(json.error), missing: json.details?.missing };
    return { ok: true, version: 0 };
  } catch {
    return { ok: false, error: "saveFailed" };
  }
}

// 024 FR-9: one question per screen; `Save and continue later`; `Submit`. A red-flag question answered `yes`
// shows the emergency advice at once and is saved straight away so the care team is told.
export function CheckinForm({
  assessmentId,
  items,
  initialAnswers,
  initialVersion,
}: {
  assessmentId: string;
  items: FormItem[];
  initialAnswers: Answers;
  initialVersion: number;
}) {
  const t = useT("family.assessments");
  const ta = useT("assessments.answers");
  const tc = useT("assessments");
  const router = useRouter();
  const firstOpen = Math.max(0, items.findIndex((i) => !initialAnswers[i.id]));
  const [index, setIndex] = useState(firstOpen);
  const [answers, setAnswers] = useState<Answers>(initialAnswers);
  const [dirty, setDirty] = useState<Answers>({});
  const version = useRef(initialVersion);
  const [busy, setBusy] = useState<"save" | "submit" | null>(null);
  const [error, setError] = useState<ApiErrorKey | null>(null);
  const [missing, setMissing] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);

  const item = items[index];
  const urgent = items.some((i) => i.redFlag && answers[i.id] === "yes");
  const label = (value: string) => (isAnswerKey(value) ? ta(value) : value);

  async function persist(pending: Answers): Promise<boolean> {
    if (Object.keys(pending).length === 0) return true;
    const result = await saveAnswers(fetch, assessmentId, pending, version.current);
    if (!result.ok) {
      setError(result.error);
      return false;
    }
    version.current = result.version;
    setDirty((current) => Object.fromEntries(Object.entries(current).filter(([k, v]) => pending[k] !== v)));
    return true;
  }

  async function choose(value: string) {
    setSaved(false);
    setError(null);
    setMissing((m) => m.filter((id) => id !== item.id));
    const nextAnswers = { ...answers, [item.id]: value };
    const nextDirty = { ...dirty, [item.id]: value };
    setAnswers(nextAnswers);
    setDirty(nextDirty);
    if (item.redFlag && value === "yes") {
      setBusy("save");
      await persist(nextDirty);
      setBusy(null);
    }
  }

  async function saveLater() {
    setBusy("save");
    setError(null);
    const ok = await persist(dirty);
    setBusy(null);
    setSaved(ok);
  }

  async function submit() {
    setBusy("submit");
    setError(null);
    if (!(await persist(dirty))) {
      setBusy(null);
      return;
    }
    const result = await submitAnswers(fetch, assessmentId);
    setBusy(null);
    if (!result.ok) {
      setError(result.error);
      if (result.missing?.length) {
        setMissing(result.missing);
        const first = items.findIndex((i) => result.missing?.includes(i.id));
        if (first >= 0) setIndex(first);
      }
      return;
    }
    router.refresh();
  }

  const isLast = index === items.length - 1;
  const numberOf = (id: string) => items.findIndex((i) => i.id === id) + 1;

  return (
    <div className="space-y-5">
      {urgent ? (
        <div role="alert" className="rounded-2xl border-2 border-red-600 bg-red-50 p-4 text-base font-semibold text-red-900" data-testid="urgent">
          {tc("urgent")}
        </div>
      ) : null}

      <p className="text-sm text-slate-600">{t("englishOnly")}</p>

      <fieldset className="space-y-4 rounded-2xl border border-slate-200 bg-white p-4 sm:p-6" data-item={item.id}>
        <legend className="px-1 text-sm font-medium text-slate-600">
          {item.redFlag ? t("safetyQuestion", { n: index + 1, total: items.length }) : t("questionOf", { n: index + 1, total: items.length })}
        </legend>
        <p lang="en" className="text-lg font-semibold text-slate-900">
          {item.text}
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          {item.options.map((value) => {
            const checked = answers[item.id] === value;
            return (
              <label
                key={value}
                className={`flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border px-4 py-2 text-base ${
                  checked ? "border-teal-700 bg-teal-50 font-semibold text-teal-900" : "border-slate-300 text-slate-800"
                }`}
              >
                <input
                  type="radio"
                  name={`answer-${item.id}`}
                  value={value}
                  checked={checked}
                  onChange={() => choose(value)}
                  className="h-4 w-4"
                />
                {label(value)}
              </label>
            );
          })}
        </div>
      </fieldset>

      {error ? (
        <div role="alert" className="space-y-2 text-sm font-medium text-red-700">
          <p>{t(`errors.${error}`)}</p>
          {missing.length > 0 ? <p>{t("missingList", { list: missing.map(numberOf).join(", ") })}</p> : null}
          {error === "stale" ? (
            <button type="button" className="underline" onClick={() => window.location.reload()}>
              {t("reload")}
            </button>
          ) : null}
        </div>
      ) : null}
      {saved ? (
        <p role="status" className="text-sm font-medium text-emerald-800">
          {t("saved")}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="min-h-11 rounded-xl border border-slate-300 px-4 text-sm font-medium text-slate-800 disabled:opacity-50"
          disabled={index === 0 || busy !== null}
          onClick={() => setIndex((i) => Math.max(0, i - 1))}
        >
          {t("previous")}
        </button>
        {isLast ? (
          <button
            type="button"
            className="min-h-11 rounded-xl bg-teal-700 px-4 text-sm font-semibold text-white disabled:opacity-50"
            disabled={busy !== null}
            onClick={submit}
          >
            {busy === "submit" ? t("submitting") : t("submit")}
          </button>
        ) : (
          <button
            type="button"
            className="min-h-11 rounded-xl bg-teal-700 px-4 text-sm font-semibold text-white disabled:opacity-50"
            disabled={busy !== null}
            onClick={() => setIndex((i) => Math.min(items.length - 1, i + 1))}
          >
            {t("next")}
          </button>
        )}
        <button
          type="button"
          className="min-h-11 rounded-xl border border-teal-700 px-4 text-sm font-semibold text-teal-800 disabled:opacity-50"
          disabled={busy !== null}
          onClick={saveLater}
        >
          {busy === "save" ? t("saving") : t("saveLater")}
        </button>
      </div>
    </div>
  );
}
