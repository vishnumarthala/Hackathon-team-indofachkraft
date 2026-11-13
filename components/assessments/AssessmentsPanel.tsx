"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import type { AssessmentStatus } from "@/lib/assessments/schemas";
import { useFormatter, useT } from "@/lib/i18n/client";
import { STATUS_KEYS, STATUS_STYLES, assessmentErrorKey, type ApiErrorKey } from "./view";

export type TemplateView = { id: string; title: string };
export type GuardianView = { userId: string; label: string };
export type AssessmentRowView = {
  id: string;
  title: string;
  guardian: string;
  status: AssessmentStatus;
  dueOn: string | null;
  updatedAt: string;
  redFlagCount: number;
  sharedWithParent: boolean;
};

const inputClass = "mt-1 block w-full rounded border border-slate-300 px-3 py-2 text-sm";
const buttonClass = "min-h-11 rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50";
const smallButton = "min-h-9 rounded border border-slate-300 px-3 py-1 text-sm font-medium text-slate-800 disabled:opacity-50";

// 024 FR-8: case workspace `Assessments` tab: `Send questionnaire` and the list with status.
export function AssessmentsPanel({
  caseId,
  templates,
  guardians,
  assessments,
  minDue,
}: {
  caseId: string;
  templates: TemplateView[];
  guardians: GuardianView[];
  assessments: AssessmentRowView[];
  minDue: string;
}) {
  const t = useT("assessments.provider");
  const ts = useT("assessments.status");
  const format = useFormatter();
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ApiErrorKey | null>(null);
  const [sent, setSent] = useState(false);

  async function call(url: string, body?: unknown): Promise<boolean> {
    setError(null);
    setSent(false);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: body === undefined ? undefined : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        setError(assessmentErrorKey(json.error));
        return false;
      }
      router.refresh();
      return true;
    } catch {
      setError("saveFailed");
      return false;
    }
  }

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const due = String(data.get("due_on") ?? "");
    setBusy("send");
    const ok = await call(`/api/cases/${caseId}/assessments`, {
      template_id: String(data.get("template_id") ?? ""),
      assigned_to: String(data.get("assigned_to") ?? ""),
      ...(due ? { due_on: due } : {}),
    });
    setBusy(null);
    if (ok) {
      form.reset();
      setSent(true);
    }
  }

  async function cancel(row: AssessmentRowView) {
    if (!window.confirm(t("cancelConfirm", { title: row.title }))) return;
    setBusy(row.id);
    await call(`/api/assessments/${row.id}/cancel`);
    setBusy(null);
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">{t("title")}</h2>
        <p className="text-sm text-slate-700">{t("intro")}</p>
      </div>

      <section aria-labelledby="send-questionnaire" className="space-y-3 rounded border border-slate-200 bg-white p-4">
        <h3 id="send-questionnaire" className="font-semibold">
          {t("send")}
        </h3>
        {guardians.length === 0 ? (
          <p className="text-sm text-slate-700">{t("noGuardians")}</p>
        ) : (
          <form onSubmit={send} className="grid gap-3 sm:grid-cols-3">
            <label className="block text-sm font-medium text-slate-800">
              {t("template")}
              <select name="template_id" required className={inputClass} defaultValue={templates[0]?.id ?? ""}>
                {templates.map((tpl) => (
                  <option key={tpl.id} value={tpl.id}>
                    {tpl.title}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm font-medium text-slate-800">
              {t("parent")}
              <select name="assigned_to" required className={inputClass} defaultValue={guardians[0]?.userId ?? ""}>
                {guardians.map((g) => (
                  <option key={g.userId} value={g.userId}>
                    {g.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm font-medium text-slate-800">
              {t("dueDate")}
              <input type="date" name="due_on" min={minDue} className={inputClass} />
            </label>
            <div className="sm:col-span-3">
              <button type="submit" className={buttonClass} disabled={busy !== null}>
                {busy === "send" ? t("sending") : t("send")}
              </button>
            </div>
          </form>
        )}
        {sent ? (
          <p role="status" className="text-sm font-medium text-emerald-800">
            {t("sent")}
          </p>
        ) : null}
      </section>

      {error ? (
        <p role="alert" className="text-sm font-medium text-red-700">
          {t(`errors.${error}`)}
        </p>
      ) : null}

      {assessments.length === 0 ? (
        <p className="text-slate-700">{t("empty")}</p>
      ) : (
        <ul className="divide-y divide-slate-200 rounded border border-slate-200 bg-white" aria-label={t("listLabel")}>
          {assessments.map((row) => (
            <li key={row.id} className="flex flex-wrap items-center justify-between gap-3 px-3 py-3" data-assessment={row.id}>
              <div className="min-w-0 space-y-1">
                <p className="font-medium break-words">{row.title}</p>
                <p className="text-sm text-slate-700">
                  {t("sentTo", { name: row.guardian })} ·{" "}
                  {row.dueOn ? t("due", { date: format.date(`${row.dueOn}T12:00:00+05:30`, "short") }) : t("noDue")}
                </p>
                <p className="flex flex-wrap gap-2 text-xs font-medium">
                  <span className={`rounded-full px-2 py-0.5 ${STATUS_STYLES[row.status]}`}>{ts(STATUS_KEYS[row.status])}</span>
                  {row.redFlagCount > 0 ? (
                    <span className="rounded-full bg-red-100 px-2 py-0.5 text-red-900" data-red-flag="true">
                      {t("redFlags", { count: row.redFlagCount })}
                    </span>
                  ) : null}
                  {row.sharedWithParent ? (
                    <span className="rounded-full bg-teal-50 px-2 py-0.5 text-teal-900">{t("sharedBadge")}</span>
                  ) : null}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Link href={`/cases/${caseId}/assessments/${row.id}`} className={`${smallButton} inline-flex items-center`}>
                  {t("open")}
                </Link>
                {row.status === "assigned" || row.status === "in_progress" ? (
                  <button type="button" className={smallButton} disabled={busy !== null} onClick={() => cancel(row)}>
                    {busy === row.id ? t("cancelling") : t("cancel")}
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
