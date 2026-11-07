"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

export type EditorReport = { id: string; content_md: string; status: "draft" | "final" };

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;
export type ReportResult = { ok: true; report: EditorReport } | { ok: false; error: string };

async function call(fetchFn: FetchFn, url: string, init: RequestInit, fallback: string): Promise<ReportResult> {
  try {
    const res = await fetchFn(url, init);
    const body = (await res.json().catch(() => ({}))) as { report?: EditorReport; error?: string };
    if (res.ok && body.report) return { ok: true, report: body.report };
    return { ok: false, error: body.error ?? fallback };
  } catch {
    return { ok: false, error: fallback };
  }
}

export function generateReport(fetchFn: FetchFn, recordingId: string): Promise<ReportResult> {
  return call(fetchFn, `/api/sessions/${recordingId}/report`, { method: "POST" }, "Report could not be generated");
}

export function patchReport(
  fetchFn: FetchFn,
  reportId: string,
  body: { content_md?: string; status?: "final" },
): Promise<ReportResult> {
  return call(
    fetchFn,
    `/api/reports/${reportId}`,
    { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    "Could not save the report",
  );
}

export function generateLabel(report: EditorReport | null): string {
  return report ? "Regenerate draft" : "Generate draft report";
}

const buttonClass =
  "inline-flex min-h-11 items-center rounded px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60";

const markdownComponents: Components = {
  h1: ({ children }) => <h3 className="text-xl font-semibold">{children}</h3>,
  h2: ({ children }) => <h4 className="mt-4 text-lg font-semibold">{children}</h4>,
  h3: ({ children }) => <h5 className="mt-3 font-semibold">{children}</h5>,
  p: ({ children }) => <p className="mt-2">{children}</p>,
  ul: ({ children }) => <ul className="mt-2 list-disc pl-5">{children}</ul>,
  table: ({ children }) => <table className="mt-2 border-collapse text-sm">{children}</table>,
  th: ({ children }) => <th className="border border-slate-300 px-2 py-1 text-left">{children}</th>,
  td: ({ children }) => <td className="border border-slate-300 px-2 py-1">{children}</td>,
};

export function ReportPreview({ markdown }: { markdown: string }) {
  return (
    <div aria-label="Report preview" className="rounded border border-slate-200 bg-white p-4 text-slate-900">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {markdown}
      </ReactMarkdown>
    </div>
  );
}

export function ReportEditor({ recordingId, initialReport }: { recordingId: string; initialReport: EditorReport | null }) {
  const router = useRouter();
  const [report, setReport] = useState<EditorReport | null>(initialReport);
  const [text, setText] = useState(initialReport?.content_md ?? "");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Wrapped so the browser fetch is never called detached ("Illegal invocation").
  const fetchFn: FetchFn = (input, init) => fetch(input, init);

  async function run(action: () => Promise<ReportResult>, after?: () => void) {
    setBusy(true);
    setError(null);
    setSaved(false);
    const result = await action();
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setReport(result.report);
    setText(result.report.content_md);
    after?.();
  }

  const isFinal = report?.status === "final";

  return (
    <div className="space-y-4">
      {!isFinal && (
        <button
          type="button"
          disabled={busy}
          onClick={() => run(() => generateReport(fetchFn, recordingId))}
          className={`${buttonClass} bg-slate-900 text-white`}
        >
          {generateLabel(report)}
        </button>
      )}

      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}

      {report && (
        <div className="space-y-4">
          {isFinal && (
            <span className="inline-block rounded bg-emerald-100 px-2 py-0.5 text-sm font-semibold text-emerald-900">
              Final
            </span>
          )}
          <div>
            <label htmlFor="report-markdown" className="block text-sm font-medium text-slate-800">
              Report (Markdown)
            </label>
            <textarea
              id="report-markdown"
              value={text}
              readOnly={isFinal}
              onChange={(e) => {
                setText(e.target.value);
                setSaved(false);
              }}
              rows={18}
              className="mt-1 w-full rounded border border-slate-300 px-3 py-2 font-mono text-sm read-only:bg-slate-50"
            />
          </div>
          {!isFinal && (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={busy || text.trim() === ""}
                onClick={() => run(() => patchReport(fetchFn, report.id, { content_md: text }), () => setSaved(true))}
                className={`${buttonClass} border border-slate-300 bg-white text-slate-900`}
              >
                Save
              </button>
              <button
                type="button"
                disabled={busy || text.trim() === ""}
                onClick={() =>
                  run(() =>
                    patchReport(
                      fetchFn,
                      report.id,
                      text === report.content_md ? { status: "final" } : { content_md: text, status: "final" },
                    ),
                    // The parent voice note section is rendered by the server page once the report is final.
                    () => router.refresh(),
                  )
                }
                className={`${buttonClass} bg-emerald-700 text-white`}
              >
                Mark final
              </button>
              {saved && (
                <span role="status" className="text-sm text-slate-700">
                  Saved
                </span>
              )}
            </div>
          )}
          <ReportPreview markdown={text} />
        </div>
      )}
    </div>
  );
}
