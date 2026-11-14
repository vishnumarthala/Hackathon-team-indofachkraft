"use client";

// Ticket 039 FR-5: case workspace `Prescriptions` tab (rendered only for verified prescribers; every API re-checks).
// List, the 038 AI draft card (`?from_report_id=`), the draft editor (item rows, allergy banner from the 021 health
// profile, `Save draft`, `Sign and generate PDF` with the confirmation dialog) and the read-only signed view with
// `Download PDF` and `Void`.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useFormatter, useT } from "@/lib/i18n/client";
import { RX_FORMS, allergyMatches, blankItem, MAX_ITEMS, type AllergyMatch, type RxItem, type RxStatus } from "@/lib/rx/schema";
import { Button } from "@/components/ui/Button";

export type PanelSummary = {
  id: string;
  status: RxStatus;
  items: number;
  prescriber_name: string;
  signed_at: string | null;
  created_at: string;
  from_ai_draft: boolean;
};

export type PanelDetail = {
  id: string;
  status: RxStatus;
  version: number;
  void_reason: string | null;
  voided_at: string | null;
  items: RxItem[];
  advice: string | null;
  follow_up: string | null;
  signed_at: string | null;
  content_hash: string | null;
  prescriber_name: string;
};

export type PanelHealth = {
  recorded: boolean;
  noKnownAllergies: boolean;
  allergies: { substance: string; severity: string; reaction: string }[];
  medications: { name: string; dose: string; frequency: string }[];
};

export type PanelDraftReport = { id: string; items: { drug: string; dose: string; frequency: string; duration_days: number }[] };

type Props = {
  caseId: string;
  list: PanelSummary[];
  selected: PanelDetail | null;
  draftReport: PanelDraftReport | null;
  draftStartedId: string | null;
  health: PanelHealth;
};

const button = "inline-flex min-h-11 items-center rounded px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60";
const secondary = `${button} border border-slate-400 text-slate-900`;
const danger = `${button} border border-red-700 text-red-800`;
const card = "space-y-3 rounded border border-slate-200 bg-white p-4";
const input = "mt-1 block min-h-11 w-full rounded border border-slate-400 px-3 py-2 text-sm";
const labelClass = "block text-sm font-medium text-slate-900";

type ApiResult = { ok: boolean; status: number; json: Record<string, unknown> };

async function send(url: string, method: string, body?: unknown): Promise<ApiResult> {
  try {
    const res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { ok: res.ok, status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  } catch {
    return { ok: false, status: 0, json: {} };
  }
}

function errorOf(res: ApiResult, fallback: string): string {
  if (typeof res.json.error !== "string") return fallback;
  const details = res.json.details;
  const first = details && typeof details === "object" ? Object.values(details).find((v) => typeof v === "string") : undefined;
  return first ? `${res.json.error}: ${first}` : res.json.error;
}
const pathFor = (caseId: string, id: string) => `/cases/${caseId}/prescriptions?rx=${encodeURIComponent(id)}`;

function ErrorLine({ error }: { error: string | null }) {
  return error ? (
    <p role="alert" className="text-sm font-medium text-red-700">
      {error}
    </p>
  ) : null;
}

function StatusBadge({ status }: { status: RxStatus }) {
  const t = useT("rx.status");
  const tone =
    status === "signed" ? "bg-emerald-100 text-emerald-900" : status === "void" ? "bg-red-100 text-red-900" : "bg-amber-100 text-amber-900";
  return <span className={`rounded px-2 py-0.5 text-xs font-semibold ${tone}`}>{t(status)}</span>;
}

function Modal({ open, onClose, labelledBy, children }: { open: boolean; onClose: () => void; labelledBy: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      if (typeof el.showModal === "function") el.showModal();
      else el.setAttribute("open", "");
    } else if (!open && el.open) {
      if (typeof el.close === "function") el.close();
      else el.removeAttribute("open");
    }
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={labelledBy}
      onClose={onClose}
      className="m-auto w-[calc(100%-1rem)] max-w-lg rounded p-0 backdrop:bg-slate-900/50"
    >
      {children}
    </dialog>
  );
}

function AllergyBanner({ health }: { health: PanelHealth }) {
  const t = useT("rx.allergies");
  const list = health.allergies
    .map((a) => `${a.substance}${a.severity && a.severity !== "unknown" ? ` (${a.severity})` : ""}`)
    .join(", ");
  return (
    <div className="space-y-1">
      {health.allergies.length > 0 ? (
        <p role="note" className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm font-medium text-red-900" data-allergy="listed">
          {t("listed", { list })}
        </p>
      ) : health.noKnownAllergies ? (
        <p role="note" className="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800" data-allergy="none_known">
          {t("none")}
        </p>
      ) : (
        <p role="note" className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-900" data-allergy="not_recorded">
          {t("unknown")}
        </p>
      )}
      {health.medications.length > 0 ? (
        <p className="text-sm text-slate-700">
          {t("medicines", { list: health.medications.map((m) => [m.name, m.dose, m.frequency].filter(Boolean).join(" ")).join("; ") })}
        </p>
      ) : null}
    </div>
  );
}

function DraftCard({ caseId, report, startedId }: { caseId: string; report: PanelDraftReport; startedId: string | null }) {
  const t = useT("rx.fromDraft");
  const tr = useT("rx");
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function start() {
    setBusy(true);
    setError(null);
    const res = await send(`/api/cases/${caseId}/prescriptions`, "POST", { from_report_id: report.id });
    setBusy(false);
    const id = (res.json.prescription as { id?: string } | undefined)?.id;
    if (!res.ok || !id) return setError(errorOf(res, tr("errors.generic")));
    router.push(pathFor(caseId, id));
    router.refresh();
  }
  return (
    <section aria-labelledby="rx-draft-heading" className={card} data-rx-draft={report.id}>
      <h3 id="rx-draft-heading" className="text-lg font-semibold">
        {t("title")}
      </h3>
      <p className="w-fit rounded bg-violet-100 px-2 py-0.5 text-xs font-semibold text-violet-900">{tr("aiLabel")}</p>
      <p className="text-sm text-slate-700">{t("intro")}</p>
      {report.items.length === 0 ? (
        <p>{t("none")}</p>
      ) : (
        <ol className="list-decimal space-y-1 pl-5 text-sm">
          {report.items.map((item, i) => (
            <li key={i}>{[item.drug, item.dose, item.frequency].filter(Boolean).join(" - ")}</li>
          ))}
        </ol>
      )}
      {startedId ? (
        <Link href={pathFor(caseId, startedId)} className={`${secondary} w-fit`}>
          {t("open")}
        </Link>
      ) : (
        <Button type="button" disabled={busy} onClick={start}>
          {busy ? tr("creating") : t("start")}
        </Button>
      )}
      <ErrorLine error={error} />
    </section>
  );
}

function ItemRow({
  index,
  item,
  matches,
  onChange,
  onRemove,
}: {
  index: number;
  item: RxItem;
  matches: AllergyMatch[];
  onChange: (next: RxItem) => void;
  onRemove: () => void;
}) {
  const t = useT("rx.editor");
  const tf = useT("rx.forms");
  const id = useId();
  const n = index + 1;
  const field = (key: "drug" | "strength" | "dose" | "frequency" | "route", label: string, max: number) => (
    <div>
      <label htmlFor={`${id}-${key}`} className={labelClass}>
        {label}
      </label>
      <input
        id={`${id}-${key}`}
        value={item[key]}
        maxLength={max}
        onChange={(e) => onChange({ ...item, [key]: e.target.value })}
        className={input}
        required={key !== "strength"}
      />
    </div>
  );
  return (
    <fieldset className="space-y-3 rounded border border-slate-200 p-3" data-item={index}>
      <legend className="px-1 text-sm font-semibold">{t("medicine", { n })}</legend>
      {matches.map((m) => (
        <p key={m.substance} role="alert" className="rounded bg-red-50 px-3 py-2 text-sm font-semibold text-red-800">
          {t("allergyMatch", { substance: m.substance })}
        </p>
      ))}
      <div className="grid gap-3 sm:grid-cols-2">
        {field("drug", t("drug"), 120)}
        {field("strength", t("strength"), 60)}
        <div>
          <label htmlFor={`${id}-form`} className={labelClass}>
            {t("form")}
          </label>
          <select
            id={`${id}-form`}
            value={item.form}
            onChange={(e) => onChange({ ...item, form: e.target.value as RxItem["form"] })}
            className={input}
          >
            {RX_FORMS.map((f) => (
              <option key={f} value={f}>
                {tf(f)}
              </option>
            ))}
          </select>
        </div>
        {field("dose", t("dose"), 60)}
        {field("frequency", t("frequency"), 60)}
        <div>
          <label htmlFor={`${id}-duration`} className={labelClass}>
            {t("duration")}
          </label>
          <input
            id={`${id}-duration`}
            type="number"
            inputMode="numeric"
            min={1}
            max={365}
            step={1}
            value={Number.isFinite(item.duration_days) ? item.duration_days : ""}
            onChange={(e) => onChange({ ...item, duration_days: Number(e.target.value) })}
            className={input}
            required
          />
        </div>
        {field("route", t("route"), 40)}
      </div>
      <div>
        <label htmlFor={`${id}-instructions`} className={labelClass}>
          {t("instructions")}
        </label>
        <input
          id={`${id}-instructions`}
          value={item.instructions ?? ""}
          maxLength={300}
          onChange={(e) => onChange({ ...item, instructions: e.target.value || null })}
          className={input}
        />
      </div>
      <button type="button" className={secondary} onClick={onRemove}>
        {t("remove", { n })}
      </button>
    </fieldset>
  );
}

function Editor({ detail, health }: { detail: PanelDetail; health: PanelHealth }) {
  const t = useT("rx.editor");
  const tc = useT("rx.confirm");
  const te = useT("rx.errors");
  const router = useRouter();
  const id = useId();
  const [items, setItems] = useState<RxItem[]>(detail.items.length ? detail.items : [blankItem()]);
  const [advice, setAdvice] = useState(detail.advice ?? "");
  const [followUp, setFollowUp] = useState(detail.follow_up ?? "");
  const [version, setVersion] = useState(detail.version);
  const [dirty, setDirty] = useState(detail.items.length === 0);
  const [busy, setBusy] = useState<"save" | "sign" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [reason, setReason] = useState("");
  const [serverMatches, setServerMatches] = useState<AllergyMatch[]>([]);

  const matches = allergyMatches(items, health.allergies);
  const allMatches = matches.length ? matches : serverMatches;
  const edit = (fn: () => void) => {
    fn();
    setDirty(true);
    setStatus(null);
  };

  async function save(): Promise<boolean> {
    setBusy("save");
    setError(null);
    const res = await send(`/api/prescriptions/${detail.id}`, "PATCH", {
      items: items.map((i) => ({ ...i, duration_days: Math.round(i.duration_days) })),
      advice: advice || null,
      follow_up: followUp || null,
      version,
    });
    setBusy(null);
    if (!res.ok) {
      setError(errorOf(res, te("generic")));
      return false;
    }
    const next = (res.json.prescription as { version?: number } | undefined)?.version;
    if (typeof next === "number") setVersion(next);
    setDirty(false);
    setStatus(t("saved"));
    return true;
  }

  async function startSign() {
    setError(null);
    if (dirty && !(await save())) return;
    setConfirmed(false);
    setOpen(true);
  }

  async function sign(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!confirmed) return setError(te("confirmRequired"));
    if (allMatches.length && !reason.trim()) return setError(te("reasonRequired"));
    setBusy("sign");
    setError(null);
    const res = await send(`/api/prescriptions/${detail.id}/sign`, "POST", {
      confirm: true,
      ...(allMatches.length ? { allergy_override_reason: reason.trim() } : {}),
    });
    setBusy(null);
    if (!res.ok) {
      const m = (res.json.details as { matches?: AllergyMatch[] } | undefined)?.matches;
      if (res.status === 422 && Array.isArray(m)) setServerMatches(m);
      return setError(errorOf(res, te("generic")));
    }
    setOpen(false);
    router.refresh();
  }

  return (
    <section aria-labelledby="rx-editor-heading" className={card} data-rx={detail.id} data-status="draft">
      <div className="flex flex-wrap items-center gap-2">
        <h3 id="rx-editor-heading" className="text-lg font-semibold">
          {t("heading")}
        </h3>
        <StatusBadge status="draft" />
      </div>
      <AllergyBanner health={health} />
      <h4 className="font-semibold">{t("medicines")}</h4>
      {items.map((item, i) => (
        <ItemRow
          key={i}
          index={i}
          item={item}
          matches={matches.filter((m) => m.item_index === i)}
          onChange={(next) => edit(() => setItems((prev) => prev.map((x, j) => (j === i ? next : x))))}
          onRemove={() => edit(() => setItems((prev) => prev.filter((_, j) => j !== i)))}
        />
      ))}
      {items.length < MAX_ITEMS ? (
        <button type="button" className={secondary} onClick={() => edit(() => setItems((prev) => [...prev, blankItem()]))}>
          {t("add")}
        </button>
      ) : (
        <p className="text-sm text-slate-700">{t("maxItems")}</p>
      )}
      <div>
        <label htmlFor={`${id}-advice`} className={labelClass}>
          {t("advice")}
        </label>
        <textarea
          id={`${id}-advice`}
          value={advice}
          maxLength={2000}
          rows={3}
          onChange={(e) => edit(() => setAdvice(e.target.value))}
          className={input}
        />
      </div>
      <div>
        <label htmlFor={`${id}-follow`} className={labelClass}>
          {t("followUp")}
        </label>
        <input id={`${id}-follow`} value={followUp} maxLength={300} onChange={(e) => edit(() => setFollowUp(e.target.value))} className={input} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={secondary} disabled={busy !== null} onClick={save}>
          {busy === "save" ? t("saving") : t("save")}
        </button>
        <Button type="button" disabled={busy !== null || items.length === 0} onClick={startSign}>
          {t("sign")}
        </Button>
        <span role="status" className="text-sm text-slate-700">
          {status ?? (dirty ? t("unsaved") : "")}
        </span>
      </div>
      {!open ? <ErrorLine error={error} /> : null}
      <Modal open={open} onClose={() => setOpen(false)} labelledBy={`${id}-confirm-title`}>
        <form onSubmit={sign} className="space-y-4 p-4 sm:p-6" noValidate>
          <h3 id={`${id}-confirm-title`} className="text-lg font-semibold">
            {tc("title")}
          </h3>
          <AllergyBanner health={health} />
          {allMatches.length ? (
            <div className="space-y-2">
              <p role="alert" className="rounded bg-red-50 px-3 py-2 text-sm font-semibold text-red-800">
                {tc("matches", { list: allMatches.map((m) => `${m.drug} - ${m.substance}`).join("; ") })}
              </p>
              <label htmlFor={`${id}-override`} className={labelClass}>
                {tc("overrideLabel")}
              </label>
              <textarea
                id={`${id}-override`}
                value={reason}
                maxLength={500}
                rows={2}
                onChange={(e) => setReason(e.target.value)}
                className={input}
                required
              />
            </div>
          ) : null}
          <label className="flex items-start gap-3 text-sm font-medium text-slate-900">
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="mt-1 size-5" />
            <span>{tc("text")}</span>
          </label>
          <ErrorLine error={error} />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy !== null || !confirmed}>
              {busy === "sign" ? tc("signing") : tc("sign")}
            </Button>
            <button type="button" className={secondary} onClick={() => setOpen(false)}>
              {tc("cancel")}
            </button>
          </div>
        </form>
      </Modal>
    </section>
  );
}

function SignedView({ detail }: { detail: PanelDetail }) {
  const t = useT("rx.signed");
  const tc = useT("rx.confirm");
  const te = useT("rx.errors");
  const tf = useT("rx.forms");
  const tr = useT("rx.editor");
  const format = useFormatter();
  const router = useRouter();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function doVoid(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!reason.trim()) return setError(te("reasonRequired"));
    setBusy(true);
    setError(null);
    const res = await send(`/api/prescriptions/${detail.id}/void`, "POST", { reason: reason.trim() });
    setBusy(false);
    if (!res.ok) return setError(errorOf(res, te("generic")));
    setOpen(false);
    router.refresh();
  }

  return (
    <section aria-labelledby="rx-signed-heading" className={card} data-rx={detail.id} data-status={detail.status}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 id="rx-signed-heading" className="text-lg font-semibold">
          {tr("signedHeading")}
        </h3>
        <StatusBadge status={detail.status} />
      </div>
      {detail.signed_at ? <p className="text-sm text-slate-700">{t("by", { name: detail.prescriber_name, date: format.dateTime(detail.signed_at) })}</p> : null}
      {detail.status === "void" && detail.voided_at ? (
        <p className="rounded bg-red-50 px-3 py-2 text-sm font-medium text-red-900">
          {t("voided", { date: format.dateTime(detail.voided_at), reason: detail.void_reason ?? "" })}
        </p>
      ) : null}
      <ol className="list-decimal space-y-2 pl-5 text-sm">
        {detail.items.map((item, i) => (
          <li key={i}>
            <span className="font-semibold">{[item.drug, item.strength, tf(item.form)].filter(Boolean).join(" ")}</span>
            {" - "}
            {[item.dose, item.frequency, `${item.duration_days} ${tr("duration").toLowerCase()}`, item.route].filter(Boolean).join(", ")}
            {item.instructions ? <span className="block text-slate-700">{item.instructions}</span> : null}
          </li>
        ))}
      </ol>
      {detail.advice ? (
        <div>
          <h4 className="font-semibold">{tr("advice")}</h4>
          <p className="text-sm whitespace-pre-line">{detail.advice}</p>
        </div>
      ) : null}
      {detail.follow_up ? (
        <div>
          <h4 className="font-semibold">{tr("followUp")}</h4>
          <p className="text-sm">{detail.follow_up}</p>
        </div>
      ) : null}
      <p className="text-sm text-slate-700">{tr("readOnly")}</p>
      {detail.content_hash ? <p className="text-xs break-all text-slate-600">{t("hash", { hash: detail.content_hash })}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button asChild>
          <a href={`/api/prescriptions/${detail.id}/pdf`} download>
            {t("download")}
          </a>
        </Button>
        {detail.status === "signed" ? (
          <button type="button" className={danger} onClick={() => setOpen(true)}>
            {t("void")}
          </button>
        ) : null}
      </div>
      <Modal open={open} onClose={() => setOpen(false)} labelledBy={`${id}-void-title`}>
        <form onSubmit={doVoid} className="space-y-4 p-4 sm:p-6" noValidate>
          <h3 id={`${id}-void-title`} className="text-lg font-semibold">
            {t("voidTitle")}
          </h3>
          <p className="text-sm text-slate-700">{t("voidIntro")}</p>
          <div>
            <label htmlFor={`${id}-void-reason`} className={labelClass}>
              {t("voidReason")}
            </label>
            <textarea
              id={`${id}-void-reason`}
              value={reason}
              maxLength={500}
              rows={2}
              onChange={(e) => setReason(e.target.value)}
              className={input}
              required
            />
          </div>
          <ErrorLine error={error} />
          <div className="flex flex-wrap gap-2">
            <button type="submit" className={danger} disabled={busy}>
              {busy ? t("voiding") : t("voidConfirm")}
            </button>
            <button type="button" className={secondary} onClick={() => setOpen(false)}>
              {tc("cancel")}
            </button>
          </div>
        </form>
      </Modal>
    </section>
  );
}

export function PrescriptionsPanel({ caseId, list, selected, draftReport, draftStartedId, health }: Props) {
  const t = useT("rx");
  const format = useFormatter();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    const res = await send(`/api/cases/${caseId}/prescriptions`, "POST", {});
    setBusy(false);
    const id = (res.json.prescription as { id?: string } | undefined)?.id;
    if (!res.ok || !id) return setError(errorOf(res, t("errors.generic")));
    router.push(pathFor(caseId, id));
    router.refresh();
  }

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-xl font-semibold">{t("title")}</h2>
          <p className="text-sm text-slate-700">{t("intro")}</p>
        </div>
        <Button type="button" disabled={busy} onClick={create}>
          {busy ? t("creating") : t("new")}
        </Button>
      </header>
      <ErrorLine error={error} />
      {draftReport ? <DraftCard caseId={caseId} report={draftReport} startedId={draftStartedId} /> : null}
      {selected ? (
        selected.status === "draft" ? (
          <Editor key={`${selected.id}:${selected.version}`} detail={selected} health={health} />
        ) : (
          <SignedView key={`${selected.id}:${selected.version}`} detail={selected} />
        )
      ) : null}
      <section aria-labelledby="rx-list-heading" className="space-y-2">
        <h3 id="rx-list-heading" className="text-lg font-semibold">
          {t("list.heading")}
        </h3>
        {list.length === 0 ? (
          <p className="text-sm text-slate-700">{t("list.empty")}</p>
        ) : (
          <ul className="divide-y divide-slate-200 rounded border border-slate-200 bg-white">
            {list.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 p-3" data-rx-row={p.id}>
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge status={p.status} />
                    <span className="text-sm font-medium">{t("list.items", { count: p.items })}</span>
                    {p.from_ai_draft ? <span className="text-xs text-violet-900">{t("list.fromAi")}</span> : null}
                  </div>
                  <p className="text-sm text-slate-700">
                    {p.signed_at
                      ? t("list.signedOn", { date: format.date(p.signed_at, "long"), name: p.prescriber_name })
                      : t("list.startedOn", { date: format.date(p.created_at, "long"), name: p.prescriber_name })}
                  </p>
                </div>
                <Link
                  href={pathFor(caseId, p.id)}
                  aria-current={selected?.id === p.id ? "true" : undefined}
                  className={`${secondary} ${selected?.id === p.id ? "bg-slate-100" : ""}`}
                >
                  {t("list.open")}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
