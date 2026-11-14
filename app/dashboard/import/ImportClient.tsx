"use client";

// Ticket 047: CSV import wizard (upload -> preview -> import -> code list), the code list with WhatsApp links and
// the `Record paper consent` shortcut, and the undo / new-codes buttons of an import page.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, type FormEvent } from "react";
import { MAX_FILE_BYTES, toCsv } from "@/lib/import/csv";
import type { CodeItem, ImportRecord, PreviewJson } from "@/lib/import/store";
import { formatWeekdays } from "@/lib/import/timetable";
import type { Issue } from "@/lib/import/validate";
import { useFormatter, useT } from "@/lib/i18n/client";
import { Button } from "@/components/ui/Button";

const inputClass = "mt-1 block w-full rounded border border-slate-300 px-3 py-2 text-sm";
const secondaryClass =
  "inline-flex min-h-11 items-center justify-center rounded border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-900 disabled:opacity-50";
const LANGUAGE_NAMES: Record<string, string> = { en: "English", hi: "हिन्दी", te: "తెలుగు" };

type Json = Record<string, unknown>;

async function readJson(res: Response): Promise<Json> {
  return (await res.json().catch(() => ({}))) as Json;
}

function useIssueText() {
  const t = useT("childImport.issues");
  return (i: Issue) => t(i.code, i.params);
}

function downloadCsv(items: CodeItem[], consentGiven: Record<string, boolean>) {
  const csv = toCsv([
    ["row", "child", "guardian", "phone", "code", "expires_at", "whatsapp_link", "message", "consent"],
    ...items.map((i) => [i.row, i.child_name, i.guardian_name, i.guardian_phone, i.code, i.expires_at, i.whatsapp_url, i.message, consentGiven[i.child_id] ? "given" : "none"]),
  ]);
  const url = URL.createObjectURL(new Blob([`\uFEFF${csv}\r\n`], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "doctornearme-claim-codes.csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** FR-4: imported children with their one-time codes, WhatsApp links and the paper consent shortcut. */
export function CodeList({ items, consentGiven = {} }: { items: CodeItem[]; consentGiven?: Record<string, boolean> }) {
  const t = useT("childImport");
  const format = useFormatter();
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <button type="button" className={secondaryClass} onClick={() => downloadCsv(items, consentGiven)}>
          {t("download")}
        </button>
      </div>
      <ol className="divide-y divide-slate-200 rounded border border-slate-200" data-testid="code-list">
        {items.map((item) => (
          <li key={item.case_id} className="flex flex-col gap-2 px-3 py-3 text-sm sm:flex-row sm:items-start sm:justify-between" data-case={item.case_id}>
            <div className="min-w-0 space-y-1">
              <Link href={`/cases/${item.case_id}`} className="block break-words font-medium underline">
                {item.child_name}
              </Link>
              <p className="break-words text-slate-700">
                {t("col.guardian")}: {item.guardian_name}
                {item.guardian_phone ? ` · ${item.guardian_phone}` : ""}
              </p>
              <p>
                <span className="mr-2 text-slate-600">{t("col.code")}:</span>
                <span className="font-mono text-base font-semibold" data-testid="claim-code">
                  {item.code}
                </span>
                <span className="block text-xs text-slate-600">{t("expires", { date: format.dateTime(item.expires_at) })}</span>
              </p>
              <p data-testid="consent-status">
                <span className="text-slate-600">{t("col.consent")}:</span>{" "}
                <span className="font-medium">{consentGiven[item.child_id] ? t("given") : t("notGiven")}</span>
              </p>
            </div>
            <div className="flex flex-wrap gap-2 sm:flex-col sm:items-stretch">
              <a href={item.whatsapp_url} target="_blank" rel="noreferrer" className={secondaryClass}>
                {t("whatsapp")}
              </a>
              <Link href={item.paper_consent_path} className={secondaryClass}>
                {t("paperConsent")}
              </Link>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function IssueList({ issues, tone }: { issues: Issue[]; tone: "error" | "warning" }) {
  const text = useIssueText();
  if (issues.length === 0) return null;
  return (
    <ul className={tone === "error" ? "text-red-700" : "text-amber-800"}>
      {issues.map((i, n) => (
        <li key={`${i.code}-${n}`}>{text(i)}</li>
      ))}
    </ul>
  );
}

type ImportResult = {
  import: ImportRecord;
  items: CodeItem[];
  failed: { row: number; errors: Issue[] }[];
  skipped: number[];
};

export function ImportWizard({ orgs }: { orgs: { id: string; name: string }[] }) {
  const t = useT("childImport");
  const issueText = useIssueText();
  const format = useFormatter();
  const router = useRouter();
  const [orgId, setOrgId] = useState(orgs[0]?.id ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<PreviewJson | null>(null);
  const [importAnyway, setImportAnyway] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState<"check" | "import" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  const importCount = useMemo(
    () => (preview ? preview.rows.filter((r) => r.status === "valid" || (r.status === "duplicate" && importAnyway.has(r.row))).length : 0),
    [preview, importAnyway],
  );

  function formData(withChoices: boolean): FormData {
    const data = new FormData();
    data.set("org_id", orgId);
    if (file) data.set("file", file);
    if (withChoices) data.set("import_duplicates", JSON.stringify([...importAnyway]));
    return data;
  }

  async function onCheck(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPreview(null);
    setResult(null);
    setImportAnyway(new Set());
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      setError(issueText({ code: "too_large", params: {}, message: "" }));
      return;
    }
    setBusy("check");
    try {
      const res = await fetch("/api/org/import/preview", { method: "POST", body: formData(false) });
      const json = await readJson(res);
      if (res.ok) setPreview(json as unknown as PreviewJson);
      else setError(typeof json.error === "string" ? json.error : t("requestFailed"));
    } catch {
      setError(t("requestFailed"));
    } finally {
      setBusy(null);
    }
  }

  async function onImport() {
    setError(null);
    setBusy("import");
    try {
      const res = await fetch("/api/org/import", { method: "POST", body: formData(true) });
      const json = await readJson(res);
      if (res.status === 201) {
        setResult(json as unknown as ImportResult);
        router.refresh();
      } else if (res.ok && json.result === "existing") {
        router.push(`/dashboard/import/${(json.import as ImportRecord).id}`);
      } else {
        const details = json.details as { preview?: PreviewJson } | undefined;
        if (details?.preview) setPreview(details.preview);
        setError(typeof json.error === "string" ? json.error : t("requestFailed"));
      }
    } catch {
      setError(t("requestFailed"));
    } finally {
      setBusy(null);
    }
  }

  function choose(row: number, anyway: boolean) {
    setImportAnyway((prev) => {
      const next = new Set(prev);
      if (anyway) next.add(row);
      else next.delete(row);
      return next;
    });
  }

  if (result) {
    const pending = result.import.timetable_pending_count;
    return (
      <section className="space-y-4 rounded border border-slate-200 bg-white p-4" aria-live="polite">
        <h2 className="text-lg font-semibold">{t("resultTitle")}</h2>
        <p className="font-medium" data-testid="import-counts">
          {t("resultCounts", {
            imported: result.import.imported_count,
            skipped: result.import.skipped_count,
            failed: result.import.failed_count,
          })}
        </p>
        {pending > 0 ? <p className="text-sm text-slate-700">{t("timetableSaved", { count: pending })}</p> : null}
        {result.failed.length > 0 ? <IssueList tone="error" issues={result.failed.flatMap((f) => f.errors)} /> : null}
        <p className="text-sm text-slate-700">{t("codesIntro")}</p>
        <p className="text-sm text-slate-700">{t("consentIntro")}</p>
        <CodeList items={result.items} />
        <Link href={`/dashboard/import/${result.import.id}`} className={secondaryClass}>
          {t("openImport")}
        </Link>
      </section>
    );
  }

  return (
    <div className="space-y-6">
      <section className="space-y-3 rounded border border-slate-200 bg-white p-4">
        <h2 className="text-lg font-semibold">{t("templateTitle")}</h2>
        <p className="text-sm text-slate-700">{t("templateHelp")}</p>
        <a href="/api/org/import/template" className={secondaryClass} download>
          {t("templateLink")}
        </a>
      </section>

      <form onSubmit={onCheck} className="space-y-3 rounded border border-slate-200 bg-white p-4">
        <h2 className="text-lg font-semibold">{t("uploadTitle")}</h2>
        {orgs.length > 1 ? (
          <div>
            <label htmlFor="import-org" className="block text-sm font-medium">
              {t("orgLabel")}
            </label>
            <select id="import-org" value={orgId} onChange={(e) => setOrgId(e.target.value)} className={inputClass}>
              {orgs.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <div>
          <label htmlFor="import-file" className="block text-sm font-medium">
            {t("fileLabel")}
          </label>
          <input
            id="import-file"
            name="file"
            type="file"
            accept=".csv,text/csv"
            required
            className={inputClass}
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setPreview(null);
              setError(null);
            }}
          />
        </div>
        <Button type="submit" disabled={!file || busy !== null}>
          {busy === "check" ? t("checking") : t("check")}
        </Button>
      </form>

      {error ? (
        <p role="alert" className="text-sm font-medium text-red-700">
          {error}
        </p>
      ) : null}

      {preview ? (
        <section className="space-y-3 rounded border border-slate-200 bg-white p-4" aria-labelledby="import-preview-heading">
          <h2 id="import-preview-heading" className="text-lg font-semibold">
            {t("previewTitle")}
          </h2>
          {preview.file_errors.length > 0 ? (
            <div role="alert">
              <IssueList tone="error" issues={preview.file_errors} />
            </div>
          ) : null}
          <IssueList tone="warning" issues={preview.file_warnings} />
          {preview.already_imported ? (
            <p className="rounded bg-amber-50 p-3 text-sm text-amber-900">
              {t("alreadyImported", { date: format.dateTime(preview.already_imported.created_at) })}{" "}
              <Link href={`/dashboard/import/${preview.already_imported.id}`} className="font-medium underline">
                {t("openThatImport")}
              </Link>
            </p>
          ) : null}
          {preview.has_timetable ? (
            <p className="rounded bg-slate-50 p-3 text-sm text-slate-800" data-testid="timetable-notice">
              {preview.series_available ? t("timetableAvailable") : t("timetablePending")}
            </p>
          ) : null}
          {preview.rows.length > 0 ? (
            <>
              <p className="font-medium" data-testid="preview-summary">
                {t("summary", {
                  total: preview.summary.total,
                  valid: preview.summary.valid,
                  duplicates: preview.summary.duplicates,
                  errors: preview.summary.errors,
                })}
              </p>
              <p className="text-sm text-slate-600">{t("rowNumbers")}</p>
              {/* One card per row (no horizontal scrolling at 375 px): messages and duplicate choices stay visible. */}
              <ol className="divide-y divide-slate-200 rounded border border-slate-200" data-testid="preview-table">
                {preview.rows.map((r) => (
                  <li key={r.row} className="space-y-1 px-3 py-2 text-sm" data-status={r.status}>
                    <p className="flex flex-wrap items-baseline gap-x-3">
                      <span className="text-slate-600">
                        {t("col.row")} {r.row}
                      </span>
                      <span
                        className={
                          r.status === "valid"
                            ? "font-semibold text-emerald-800"
                            : r.status === "error"
                              ? "font-semibold text-red-700"
                              : "font-semibold text-amber-800"
                        }
                      >
                        {t(`status.${r.status}`)}
                      </span>
                    </p>
                    <p className="flex flex-wrap gap-x-3 break-words">
                      <span className="font-medium">{r.child_name || "-"}</span>
                      {r.date_of_birth ? <span>{r.date_of_birth}</span> : null}
                      <span>{LANGUAGE_NAMES[r.language] ?? r.language}</span>
                    </p>
                    <p className="flex flex-wrap gap-x-3 break-words text-slate-700">
                      <span>
                        {t("col.guardian")}: {r.guardian_name || "-"}
                      </span>
                      {r.guardian_phone ? <span>{r.guardian_phone}</span> : null}
                      {r.therapist_email ? <span>{r.therapist_email}</span> : null}
                    </p>
                    {r.timetable ? (
                      <p className="text-slate-700">
                        {t("col.timetable")}: {formatWeekdays(r.timetable.weekdays)} {r.timetable.time} · {r.timetable.service_name}
                      </p>
                    ) : null}
                    <IssueList tone="error" issues={r.errors} />
                    <IssueList tone="warning" issues={r.warnings} />
                    {r.status === "duplicate" ? (
                      <fieldset>
                        <legend className="sr-only">{t("duplicateChoice", { row: r.row })}</legend>
                        <label className="mr-4 inline-flex min-h-11 items-center gap-2">
                          <input type="radio" name={`dup-${r.row}`} checked={!importAnyway.has(r.row)} onChange={() => choose(r.row, false)} />
                          {t("skip")}
                        </label>
                        <label className="inline-flex min-h-11 items-center gap-2">
                          <input type="radio" name={`dup-${r.row}`} checked={importAnyway.has(r.row)} onChange={() => choose(r.row, true)} />
                          {t("importAnyway")}
                        </label>
                      </fieldset>
                    ) : null}
                  </li>
                ))}
              </ol>
              {importCount === 0 && !preview.already_imported ? <p className="text-sm text-slate-700">{t("nothingToImport")}</p> : null}
              <Button
                type="button"
                disabled={importCount === 0 || busy !== null || Boolean(preview.already_imported) || preview.file_errors.length > 0}
                onClick={onImport}
                data-testid="import-button"
              >
                {busy === "import" ? t("importing") : t("importButton", { count: importCount })}
              </Button>
            </>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

export function UndoButton({ importId }: { importId: string }) {
  const t = useT("childImport");
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);

  async function onClick() {
    if (!window.confirm(t("undoConfirm"))) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/org/import/${importId}/undo`, { method: "POST" });
      const json = await readJson(res);
      if (res.ok) {
        setMessage({ text: t("undoDone"), ok: true });
        router.refresh();
      } else {
        const rows = (json.details as { blocked_rows?: number[] } | undefined)?.blocked_rows;
        setMessage({
          text: rows ? t("undoBlocked", { rows: rows.join(", ") }) : typeof json.error === "string" ? json.error : t("requestFailed"),
          ok: false,
        });
      }
    } catch {
      setMessage({ text: t("requestFailed"), ok: false });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <button type="button" onClick={onClick} disabled={busy} className={secondaryClass}>
        {t("undo")}
      </button>
      {message ? (
        <p role="status" className={message.ok ? "text-sm text-emerald-800" : "text-sm text-red-700"}>
          {message.text}
        </p>
      ) : null}
    </div>
  );
}

/** 044 extra scope: create the weekly series of this import's timetables that are still saved (`pending`). */
export function SchedulePendingButton({ importId }: { importId: string }) {
  const t = useT("childImport");
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);

  async function onClick() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/org/import/${importId}/schedule`, { method: "POST" });
      const json = await readJson(res);
      if (res.ok) {
        setMessage({ text: t("schedulePendingDone", { scheduled: Number(json.scheduled ?? 0), pending: Number(json.pending ?? 0) }), ok: true });
        router.refresh();
      } else {
        setMessage({ text: typeof json.error === "string" ? json.error : t("requestFailed"), ok: false });
      }
    } catch {
      setMessage({ text: t("requestFailed"), ok: false });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <p className="text-sm text-slate-700">{t("schedulePendingHelp")}</p>
      <Button type="button" onClick={onClick} disabled={busy}>
        {t("schedulePending")}
      </Button>
      {message ? (
        <p role="status" className={message.ok ? "text-sm text-emerald-800" : "text-sm text-red-700"}>
          {message.text}
        </p>
      ) : null}
    </div>
  );
}

export function RegenerateCodes({ importId, consentGiven }: { importId: string; consentGiven: Record<string, boolean> }) {
  const t = useT("childImport");
  const [busy, setBusy] = useState(false);
  const [items, setItems] = useState<CodeItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/org/import/${importId}/codes`, { method: "POST" });
      const json = await readJson(res);
      if (res.ok) setItems(json.items as CodeItem[]);
      else setError(typeof json.error === "string" ? json.error : t("requestFailed"));
    } catch {
      setError(t("requestFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-700">{t("regenerateHelp")}</p>
      <Button type="button" onClick={onClick} disabled={busy}>
        {t("regenerate")}
      </Button>
      {error ? (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      ) : null}
      {items && items.length === 0 ? <p className="text-sm text-slate-700">{t("regenerateNone")}</p> : null}
      {items && items.length > 0 ? (
        <>
          <p className="text-sm text-slate-700">{t("codesIntro")}</p>
          <CodeList items={items} consentGiven={consentGiven} />
        </>
      ) : null}
    </div>
  );
}
