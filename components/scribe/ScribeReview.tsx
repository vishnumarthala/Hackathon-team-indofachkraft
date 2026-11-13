"use client";

// Ticket 038 FR-5: AI scribe review. Session note editor (markdown; citations jump to the audio moment, 013 pattern),
// `Finalize note` (024 publishVersion, `visible_to_guardian` default off), goal progress suggestions (`Accept` /
// `Edit value` / `Reject`, 025 recordProgress) and, for prescribers, the Rx draft card linking to 039.
// Every AI output carries the label `Suggested by DoctorNearMe - the clinician decides`.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { EvidencePlayerProvider, useEvidencePlayer } from "@/components/referral/EvidencePlayer";
import { withConsentHint } from "@/lib/consent/features";
import { useFormatter, useT } from "@/lib/i18n/client";
import { clock } from "@/lib/ask/citations";
import type { RxDraftContent } from "@/lib/scribe/schema";
import { rxReviewPath, type NoteTemplate } from "@/lib/scribe/templates";

export type ReviewSuggestion = {
  id: string;
  goal_statement: string;
  measure_type: string;
  suggested_value: number;
  evidence: { segment_id: string; quote: string; start_sec: number; verified: boolean }[];
  rationale: string;
  status: "suggested" | "accepted" | "rejected";
  decided_value: number | null;
};

export type ReviewNote = {
  id: string;
  status: "draft" | "final";
  content_md: string;
  published: { version: number; visible_to_guardian: boolean } | null;
};

export type ScribeReviewProps = {
  caseId: string;
  recordingId: string;
  sessionNumber: number | null;
  template: NoteTemplate;
  status: string;
  error: string | null;
  audioUrl: string | null;
  /** segment id -> start second, for citation links in the note. */
  segmentStarts: Record<string, number>;
  note: ReviewNote | null;
  suggestions: ReviewSuggestion[];
  rx: { id: string; content: RxDraftContent } | null;
};

const button = "inline-flex min-h-11 items-center rounded px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60";
const primary = `${button} bg-slate-900 text-white`;
const secondary = `${button} border border-slate-400 text-slate-900`;
const card = "space-y-3 rounded border border-slate-200 bg-white p-4";

type Send = (url: string, method: string, body?: unknown) => Promise<{ ok: boolean; json: Record<string, unknown> }>;

const send: Send = async (url, method, body) => {
  try {
    const res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { ok: res.ok, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  } catch {
    return { ok: false, json: {} };
  }
};

function useAction() {
  const router = useRouter();
  const t = useT("scribe.review");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function run(key: string, url: string, method: string, body?: unknown): Promise<boolean> {
    setBusy(key);
    setError(null);
    const res = await send(url, method, body);
    setBusy(null);
    if (!res.ok) {
      setError(typeof res.json.error === "string" ? withConsentHint(res.json.error) : t("error"));
      return false;
    }
    router.refresh();
    return true;
  }
  return { busy, error, run };
}

function ErrorLine({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p role="alert" className="text-sm font-medium text-red-700">
      {error}
    </p>
  );
}

function AiLabel() {
  const t = useT("scribe");
  return <p className="text-sm font-medium text-amber-800">{t("label")}</p>;
}

function PlayButton({ recordingId, startSec }: { recordingId: string; startSec: number }) {
  const t = useT("scribe.review");
  const player = useEvidencePlayer();
  const playable = player.canPlay(recordingId);
  return (
    <button
      type="button"
      disabled={!playable}
      onClick={() => player.play(recordingId, startSec)}
      aria-label={playable ? t("playFrom", { time: clock(startSec) }) : t("noAudio")}
      className="mx-1 inline-flex min-h-8 items-center rounded border border-teal-700 px-2 text-xs font-semibold text-teal-800 disabled:opacity-50"
    >
      ▶ {clock(startSec)}
    </button>
  );
}

function NotePreview({ markdown, recordingId, segmentStarts }: { markdown: string; recordingId: string; segmentStarts: Record<string, number> }) {
  const t = useT("scribe.review");
  const components: Components = {
    h1: ({ children }) => <h3 className="text-xl font-semibold">{children}</h3>,
    h2: ({ children }) => <h4 className="mt-4 text-lg font-semibold">{children}</h4>,
    p: ({ children }) => <p className="mt-2">{children}</p>,
    ul: ({ children }) => <ul className="mt-2 list-disc pl-5">{children}</ul>,
    a: ({ href, children }) => {
      const id = href?.startsWith("#seg-") ? href.slice(5) : null;
      if (id && id in segmentStarts) return <PlayButton recordingId={recordingId} startSec={segmentStarts[id]} />;
      return <span>{children}</span>;
    },
  };
  return (
    <div aria-label={t("preview")} className="rounded border border-slate-200 bg-slate-50 p-4 text-slate-900">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {markdown}
      </ReactMarkdown>
    </div>
  );
}

function NoteSection({ props }: { props: ScribeReviewProps }) {
  const t = useT("scribe.review");
  const { busy, error, run } = useAction();
  const note = props.note;
  const [text, setText] = useState(note?.content_md ?? "");
  const [share, setShare] = useState(false);
  const [saved, setSaved] = useState(false);
  const url = `/api/sessions/${props.recordingId}/scribe`;

  if (!note) {
    return (
      <section aria-labelledby="note-heading" className={card}>
        <h3 id="note-heading" className="text-lg font-semibold">
          {t("noteTitle")}
        </h3>
        <p className="text-slate-700">{t("noNote")}</p>
      </section>
    );
  }
  const shared = note.published?.visible_to_guardian === true;
  return (
    <section aria-labelledby="note-heading" className={card} data-note-status={note.status}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="note-heading" className="text-lg font-semibold">
          {t("noteTitle")}
        </h3>
        <span className="rounded bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-800">
          {note.status === "final" ? t("final") : t("draft")}
          {note.status === "final" ? ` · ${shared ? t("sharedYes") : t("sharedNo")}` : ""}
        </span>
      </div>
      {note.status === "draft" && <AiLabel />}
      {note.status === "draft" ? (
        <>
          <label htmlFor="note-text" className="block text-sm font-medium text-slate-800">
            {t("editLabel")}
          </label>
          <textarea
            id="note-text"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setSaved(false);
            }}
            rows={14}
            className="block w-full rounded border border-slate-300 p-2 font-mono text-sm"
          />
          <NotePreview markdown={text} recordingId={props.recordingId} segmentStarts={props.segmentStarts} />
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={secondary}
              disabled={busy !== null || text.trim() === ""}
              onClick={async () => setSaved(await run("save", url, "PATCH", { content_md: text }))}
            >
              {t("save")}
            </button>
            {saved && <span role="status" className="text-sm text-slate-700">{t("saved")}</span>}
          </div>
          <div className="flex items-start gap-2">
            <input id="note-share" type="checkbox" checked={share} onChange={(e) => setShare(e.target.checked)} className="mt-1 h-5 w-5" />
            <label htmlFor="note-share" className="text-sm text-slate-800">
              {t("shareCheckbox")}
            </label>
          </div>
          <button
            type="button"
            className={primary}
            disabled={busy !== null || text.trim() === ""}
            onClick={() => run("finalize", url, "PATCH", { content_md: text, status: "final", visible_to_guardian: share })}
          >
            {t("finalize")}
          </button>
        </>
      ) : (
        <>
          <NotePreview markdown={note.content_md} recordingId={props.recordingId} segmentStarts={props.segmentStarts} />
          <button
            type="button"
            className={secondary}
            disabled={busy !== null}
            onClick={() => run("share", url, "PATCH", { visible_to_guardian: !shared })}
          >
            {shared ? t("unshare") : t("share")}
          </button>
        </>
      )}
      <ErrorLine error={error} />
    </section>
  );
}

function SuggestionItem({ s, recordingId }: { s: ReviewSuggestion; recordingId: string }) {
  const t = useT("scribe.review");
  const format = useFormatter();
  const { busy, error, run } = useAction();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(s.suggested_value));
  const url = `/api/goal-suggestions/${s.id}`;
  const num = (n: number) => format.number(n);
  return (
    <li className="space-y-2 rounded border border-slate-200 p-3" data-suggestion={s.id} data-status={s.status}>
      <p className="font-semibold break-words text-slate-900">{s.goal_statement}</p>
      <p className="text-slate-800">{t("suggested", { value: num(s.suggested_value) })}</p>
      {s.evidence.map((e) => (
        <blockquote key={e.segment_id} className="border-l-4 border-slate-300 pl-3 text-sm text-slate-700">
          “{e.quote}”<PlayButton recordingId={recordingId} startSec={e.start_sec} />
        </blockquote>
      ))}
      {s.rationale && <p className="text-sm text-slate-600">{s.rationale}</p>}
      {s.status === "suggested" ? (
        <div className="flex flex-wrap items-end gap-2">
          {editing ? (
            <>
              <div>
                <label htmlFor={`value-${s.id}`} className="block text-sm font-medium text-slate-800">
                  {t("valueLabel")}
                </label>
                <input
                  id={`value-${s.id}`}
                  type="number"
                  inputMode="decimal"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  className="mt-1 block min-h-11 w-28 rounded border border-slate-300 px-2"
                />
              </div>
              <button
                type="button"
                className={primary}
                disabled={busy !== null || value.trim() === "" || Number.isNaN(Number(value))}
                onClick={() => run("accept", url, "PATCH", { status: "accepted", value: Number(value) })}
              >
                {t("acceptEdited")}
              </button>
              <button type="button" className={secondary} onClick={() => setEditing(false)}>
                {t("cancel")}
              </button>
            </>
          ) : (
            <>
              <button type="button" className={primary} disabled={busy !== null} onClick={() => run("accept", url, "PATCH", { status: "accepted" })}>
                {t("accept")}
              </button>
              <button type="button" className={secondary} disabled={busy !== null} onClick={() => setEditing(true)}>
                {t("editValue")}
              </button>
              <button type="button" className={secondary} disabled={busy !== null} onClick={() => run("reject", url, "PATCH", { status: "rejected" })}>
                {t("reject")}
              </button>
            </>
          )}
        </div>
      ) : (
        <p role="status" className="text-sm font-semibold text-slate-800">
          {s.status === "accepted" ? t("accepted", { value: num(s.decided_value ?? s.suggested_value) }) : t("rejected")}
        </p>
      )}
      <ErrorLine error={error} />
    </li>
  );
}

function RxCard({ caseId, rx }: { caseId: string; rx: { id: string; content: RxDraftContent } }) {
  const t = useT("scribe.review");
  return (
    <section aria-labelledby="rx-heading" className={card} data-rx={rx.id}>
      <h3 id="rx-heading" className="text-lg font-semibold">
        {t("rxTitle")}
      </h3>
      <AiLabel />
      <p className="text-sm text-slate-700">{t("rxIntro")}</p>
      {rx.content.items.length === 0 ? (
        <p>{t("rxNone")}</p>
      ) : (
        <ol className="list-decimal space-y-1 pl-5">
          {rx.content.items.map((item, i) => (
            <li key={i}>
              {t("rxItem", {
                drug: item.drug,
                strength: item.strength,
                form: item.form,
                dose: item.dose,
                frequency: item.frequency,
                days: item.duration_days,
                route: item.route,
              })}
            </li>
          ))}
        </ol>
      )}
      <Link href={rxReviewPath(caseId, rx.id)} className={`${primary} w-fit`}>
        {t("rxReview")}
      </Link>
    </section>
  );
}

function RunButton({ recordingId, label }: { recordingId: string; label: string }): ReactNode {
  const t = useT("scribe.review");
  const { busy, error, run } = useAction();
  return (
    <div className="space-y-1">
      <button type="button" className={secondary} disabled={busy !== null} onClick={() => run("run", `/api/sessions/${recordingId}/scribe`, "POST")}>
        {busy ? t("running") : label}
      </button>
      <ErrorLine error={error} />
    </div>
  );
}

export function ScribeReview(props: ScribeReviewProps) {
  const t = useT("scribe");
  const tr = useT("scribe.review");
  const title = tr("title", { number: props.sessionNumber ?? "?", type: t(`templates.${props.template}`) });
  const audioUrls = { [props.recordingId]: props.audioUrl };

  if (props.status !== "extracted") {
    return (
      <div className="space-y-3">
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="text-slate-800">{tr("status", { status: props.status })}</p>
        {props.error && <p className="text-sm text-red-700">{tr("failed", { error: props.error })}</p>}
        {props.status === "transcribed" && <RunButton recordingId={props.recordingId} label={tr("run")} />}
      </div>
    );
  }

  return (
    <EvidencePlayerProvider audioUrls={audioUrls}>
      <div className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">{title}</h2>
          <AiLabel />
        </div>
        <NoteSection key={`${props.note?.id}-${props.note?.status}-${props.note?.content_md.length}`} props={props} />
        <section aria-labelledby="goals-heading" className={card}>
          <h3 id="goals-heading" className="text-lg font-semibold">
            {tr("goalsTitle")}
          </h3>
          <AiLabel />
          {props.suggestions.length === 0 ? (
            <p className="text-slate-700">{tr("noGoals")}</p>
          ) : (
            <ul className="space-y-3">
              {props.suggestions.map((s) => (
                <SuggestionItem key={s.id} s={s} recordingId={props.recordingId} />
              ))}
            </ul>
          )}
          <Link href={`/cases/${props.caseId}/goals`} className="text-sm font-semibold text-teal-800 underline">
            {tr("openGoals")}
          </Link>
        </section>
        {props.rx && <RxCard caseId={props.caseId} rx={props.rx} />}
        <div className="space-y-1">
          <RunButton recordingId={props.recordingId} label={tr("rerun")} />
          <p className="text-sm text-slate-600">{tr("rerunHint")}</p>
        </div>
      </div>
    </EvidencePlayerProvider>
  );
}
