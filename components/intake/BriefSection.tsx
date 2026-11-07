"use client";

import { useState } from "react";
import type { BriefState } from "@/lib/intake/briefMarkdown";

export const BRIEF_FAILED = "The call was received but the brief could not be generated.";
export const REVIEW_FAILED = "Could not mark the brief reviewed. Please try again.";

export type ReviewResult = { ok: true } | { ok: false; message: string };

export async function markBriefReviewed(
  caseId: string,
  fetchFn: (input: string, init?: RequestInit) => Promise<Response>,
): Promise<ReviewResult> {
  try {
    const res = await fetchFn(`/api/cases/${encodeURIComponent(caseId)}/brief/reviewed`, { method: "POST" });
    if (res.ok) return { ok: true };
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, message: body.error ?? REVIEW_FAILED };
  } catch {
    return { ok: false, message: REVIEW_FAILED };
  }
}

export type BriefSectionProps = { caseId: string; therapistName: string; state: BriefState };

export function BriefSection({ caseId, therapistName, state }: BriefSectionProps) {
  const [status, setStatus] = useState(state.kind === "brief" ? state.status : "draft");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (state.kind === "none") return null;
  if (state.kind === "failed") {
    return (
      <section className="rounded border border-amber-300 bg-amber-50 p-4">
        <p role="status" className="text-sm text-amber-900">
          {BRIEF_FAILED}
        </p>
      </section>
    );
  }

  const { brief } = state;

  async function onReview() {
    setBusy(true);
    setError(null);
    const result = await markBriefReviewed(caseId, (input, init) => fetch(input, init));
    if (result.ok) setStatus("final");
    else setError(result.message);
    setBusy(false);
  }

  return (
    <section className="space-y-4 rounded border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold">Pre-session brief</h2>
        <span className="rounded-full bg-sky-100 px-2.5 py-0.5 text-xs font-medium text-sky-900">Parent-reported</span>
      </div>
      <p className="text-sm text-slate-800">{brief.summary}</p>

      {brief.red_flags.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-red-700">Red flags</h3>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-red-700">
            {brief.red_flags.map((f, i) => (
              <li key={i}>
                {`${f.label}: "${f.quote}"${f.time ? ` at ${f.time}` : ""}`}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <h3 className="text-sm font-semibold">Questions to verify</h3>
        <ol className="mt-1 list-decimal space-y-1 pl-5 text-sm text-slate-800">
          {brief.questions_to_verify.map((q, i) => (
            <li key={i}>{q}</li>
          ))}
        </ol>
      </div>

      <div>
        <h3 className="text-sm font-semibold">What the parent reported</h3>
        <table className="mt-1 w-full border-collapse text-left text-sm">
          <caption className="sr-only">What the parent reported</caption>
          <tbody>
            {brief.parent_reported.map((r, i) => (
              <tr key={i} className="border-t border-slate-200 align-top">
                <th scope="row" className="py-1.5 pr-3 font-medium text-slate-700">
                  {r.label}
                </th>
                <td className="py-1.5 text-slate-900">{r.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {status === "final" ? (
        <p role="status" className="text-sm font-medium text-emerald-800">
          Reviewed by {therapistName}
        </p>
      ) : (
        <button
          type="button"
          onClick={onReview}
          disabled={busy}
          className="inline-flex min-h-11 items-center rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-60"
        >
          Mark brief reviewed
        </button>
      )}
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
    </section>
  );
}
