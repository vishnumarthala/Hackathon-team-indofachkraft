"use client";

// Ticket 025 FR-5: case workspace `Goals` tab. Plan header (title, dates, status, `Publish to parent` /
// `Publish changes`, `Unpublished changes`), goals with SMART text, `Record progress` inline forms and progress
// charts, `Add goal`. Every write sends the plan `version` (D-4); a 409 shows the reload message.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent, type ReactNode } from "react";
import { useFormatter, useT } from "@/lib/i18n/client";
import type { GoalWithProgress, PlanSummary } from "@/lib/iep";
import { GOAL_DOMAINS, MEASURE_TYPES, VALUE_RANGES, type MeasureType } from "@/lib/iep/schema";
import { ProgressChart } from "./ProgressChart";
import {
  DOMAIN_KEYS,
  GOAL_STATUS_TONES,
  MEASURE_KEYS,
  PLAN_STATUS_TONES,
  formatValue,
  sendJson,
  trendLines,
  type FieldErrorKey,
  type FieldName,
  type IepErrorKey,
} from "./view";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";

const inputClass = "mt-1 block w-full rounded border border-slate-300 px-3 py-2 text-sm";
const labelClass = "block text-sm font-medium text-slate-800";
const smallButton = "min-h-9 rounded border border-slate-300 px-3 py-1 text-sm font-medium text-slate-800 disabled:opacity-50";

type Fields = Partial<Record<FieldName, FieldErrorKey>>;
type Problem = { error: IepErrorKey; fields: Fields } | null;

export type PlanOption = Pick<PlanSummary, "id" | "title" | "status">;

function useApi() {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<Problem>(null);
  async function run<T>(key: string, url: string, method: string, body?: unknown): Promise<T | null> {
    setBusy(key);
    setProblem(null);
    const result = await sendJson<T>(fetch, url, method, body);
    setBusy(null);
    if (!result.ok) {
      setProblem({ error: result.error, fields: result.fields });
      return null;
    }
    router.refresh();
    return result.data;
  }
  return { busy, problem, setProblem, run, refresh: () => router.refresh() };
}

function ErrorText({ problem, onReload }: { problem: Problem; onReload: () => void }) {
  const t = useT("iep.errors");
  if (!problem) return null;
  return (
    <p role="alert" className="flex flex-wrap items-center gap-2 text-sm font-medium text-red-700">
      {t(problem.error)}
      {problem.error === "stale" ? (
        <button type="button" className={smallButton} onClick={onReload}>
          {t("reload")}
        </button>
      ) : null}
    </p>
  );
}

function FieldError({ id, error }: { id: string; error?: FieldErrorKey }) {
  const t = useT("iep.fieldErrors");
  if (!error) return null;
  return (
    <span id={id} className="mt-1 block text-xs font-medium text-red-700">
      {t(error)}
    </span>
  );
}

/** Labelled input/textarea/select with an optional field error wired through aria-describedby. */
function Field({
  name,
  label,
  error,
  hint,
  children,
}: {
  name: string;
  label: string;
  error?: FieldErrorKey;
  hint?: string;
  children: (props: { id: string; "aria-invalid"?: boolean; "aria-describedby"?: string }) => ReactNode;
}) {
  const base = useId();
  const id = `${base}-${name}`;
  const described = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(" ") || undefined;
  return (
    <div>
      <label htmlFor={id} className={labelClass}>
        {label}
      </label>
      {children({ id, ...(error ? { "aria-invalid": true } : {}), ...(described ? { "aria-describedby": described } : {}) })}
      {hint ? (
        <span id={`${id}-hint`} className="mt-1 block text-xs text-slate-600">
          {hint}
        </span>
      ) : null}
      <FieldError id={`${id}-error`} error={error} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------

function PlanForm({
  submitLabel,
  busyLabel,
  initial,
  busy,
  fields,
  onSubmit,
  onCancel,
}: {
  submitLabel: string;
  busyLabel: string;
  initial?: { title: string; start_date: string; review_date: string };
  busy: boolean;
  fields: Fields;
  onSubmit: (values: { title: string; start_date: string; review_date: string }, form: HTMLFormElement) => void;
  onCancel?: () => void;
}) {
  const t = useT("iep.provider");
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    onSubmit(
      {
        title: String(data.get("title") ?? ""),
        start_date: String(data.get("start_date") ?? ""),
        review_date: String(data.get("review_date") ?? ""),
      },
      event.currentTarget,
    );
  }
  return (
    <form onSubmit={submit} className="grid gap-3 sm:grid-cols-3" noValidate>
      <div className="sm:col-span-3">
        <Field name="title" label={t("planTitle")} error={fields.title}>
          {(p) => <input {...p} name="title" required maxLength={120} defaultValue={initial?.title} className={inputClass} />}
        </Field>
      </div>
      <Field name="start_date" label={t("startDate")} error={fields.start_date}>
        {(p) => <input {...p} type="date" name="start_date" required defaultValue={initial?.start_date} className={inputClass} />}
      </Field>
      <Field name="review_date" label={t("reviewDate")} error={fields.review_date} hint={t("reviewHint")}>
        {(p) => <input {...p} type="date" name="review_date" required defaultValue={initial?.review_date} className={inputClass} />}
      </Field>
      <div className="flex flex-wrap items-end gap-2">
        <Button type="submit" disabled={busy}>
          {busy ? busyLabel : submitLabel}
        </Button>
        {onCancel ? (
          <button type="button" className={smallButton} onClick={onCancel}>
            {t("cancel")}
          </button>
        ) : null}
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------------------------------------

export type GoalFormValues = {
  domain: string;
  statement: string;
  specific: string;
  measurable: string;
  achievable: string;
  relevant: string;
  time_bound: string;
  measure_type: string;
  baseline_value: number | null;
  target_value: number | null;
  target_date: string;
};

/** Reads the goal form; empty numbers become null so the API answers with a field error. */
export function readGoalForm(data: FormData): GoalFormValues {
  const num = (name: string) => {
    const raw = String(data.get(name) ?? "").trim();
    return raw === "" || Number.isNaN(Number(raw)) ? null : Number(raw);
  };
  const str = (name: string) => String(data.get(name) ?? "");
  return {
    domain: str("domain"),
    statement: str("statement"),
    specific: str("specific"),
    measurable: str("measurable"),
    achievable: str("achievable"),
    relevant: str("relevant"),
    time_bound: str("time_bound"),
    measure_type: str("measure_type"),
    baseline_value: num("baseline_value"),
    target_value: num("target_value"),
    target_date: str("target_date"),
  };
}

function GoalForm({
  plan,
  initial,
  busy,
  fields,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  plan: Pick<PlanSummary, "start_date" | "review_date">;
  initial?: Partial<GoalWithProgress>;
  busy: boolean;
  fields: Fields;
  submitLabel: string;
  onSubmit: (values: GoalFormValues, form: HTMLFormElement) => void;
  onCancel?: () => void;
}) {
  const t = useT("iep.goal");
  const td = useT("iep.domains");
  const tm = useT("iep.measures");
  const tp = useT("iep.provider");
  const [measure, setMeasure] = useState<MeasureType>((initial?.measure_type as MeasureType) ?? "count");
  const range = VALUE_RANGES[measure];
  const numberProps = { min: range.min, ...(range.max !== null ? { max: range.max } : {}), step: range.integer ? 1 : "any" };

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit(readGoalForm(new FormData(event.currentTarget)), event.currentTarget);
  }
  const smart = [
    ["specific", t("specific"), t("specificHint")],
    ["measurable", t("measurable"), t("measurableHint")],
    ["achievable", t("achievable"), t("achievableHint")],
    ["relevant", t("relevant"), t("relevantHint")],
    ["time_bound", t("timeBound"), t("timeBoundHint")],
  ] as const;

  return (
    <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2" noValidate>
      <Field name="domain" label={t("domain")} error={fields.domain}>
        {(p) => (
          <select {...p} name="domain" required defaultValue={initial?.domain ?? "communication"} className={inputClass}>
            {GOAL_DOMAINS.map((d) => (
              <option key={d} value={d}>
                {td(DOMAIN_KEYS[d])}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field name="measure_type" label={t("measureType")} error={fields.measure_type}>
        {(p) => (
          <select
            {...p}
            name="measure_type"
            required
            value={measure}
            onChange={(e) => setMeasure(e.target.value as MeasureType)}
            className={inputClass}
          >
            {MEASURE_TYPES.map((m) => (
              <option key={m} value={m}>
                {tm(MEASURE_KEYS[m])}
              </option>
            ))}
          </select>
        )}
      </Field>
      <div className="sm:col-span-2">
        <Field name="statement" label={t("statement")} error={fields.statement} hint={t("statementHint")}>
          {(p) => (
            <textarea {...p} name="statement" required minLength={10} maxLength={500} rows={2} defaultValue={initial?.statement} className={inputClass} />
          )}
        </Field>
      </div>
      {smart.map(([name, label, hint]) => (
        <Field key={name} name={name} label={label} hint={hint} error={fields[name]}>
          {(p) => (
            <textarea {...p} name={name} required minLength={3} maxLength={300} rows={2} defaultValue={initial?.[name]} className={inputClass} />
          )}
        </Field>
      ))}
      <Field name="baseline_value" label={t("baseline")} error={fields.baseline_value}>
        {(p) => (
          <input {...p} {...numberProps} type="number" inputMode="decimal" name="baseline_value" required defaultValue={initial?.baseline_value} className={inputClass} />
        )}
      </Field>
      <Field name="target_value" label={t("target")} error={fields.target_value}>
        {(p) => (
          <input {...p} {...numberProps} type="number" inputMode="decimal" name="target_value" required defaultValue={initial?.target_value} className={inputClass} />
        )}
      </Field>
      <Field name="target_date" label={t("targetDate")} error={fields.target_date}>
        {(p) => (
          <input
            {...p}
            type="date"
            name="target_date"
            required
            min={plan.start_date}
            max={plan.review_date}
            defaultValue={initial?.target_date}
            className={inputClass}
          />
        )}
      </Field>
      <div className="flex flex-wrap items-end gap-2">
        <Button type="submit" disabled={busy}>
          {busy ? tp("saving") : submitLabel}
        </Button>
        {onCancel ? (
          <button type="button" className={smallButton} onClick={onCancel}>
            {tp("cancel")}
          </button>
        ) : null}
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------------------------------------

function GoalCard({ goal, plan, today, index }: { goal: GoalWithProgress; plan: PlanSummary; today: string; index: number }) {
  const t = useT("iep.goal");
  const td = useT("iep.domains");
  const tm = useT("iep.measures");
  const tg = useT("iep.goalStatuses");
  const tc = useT("iep.chart");
  const tt = useT("iep.trend");
  const tv = useT("iep.values");
  const tpr = useT("iep.progress");
  const format = useFormatter();
  const api = useApi();
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState(false);
  const closed = plan.status === "completed" || plan.status === "archived";
  const value = (n: number) => formatValue(tv, format, goal.measure_type, n);
  const day = (d: string) => format.date(`${d}T12:00:00+05:30`, "short");
  const range = VALUE_RANGES[goal.measure_type];
  const headingId = `goal-${goal.id}`;

  async function save(values: GoalFormValues) {
    const ok = await api.run(`edit`, `/api/iep-goals/${goal.id}`, "PATCH", { ...values, version: plan.version });
    if (ok) setEditing(false);
  }
  async function setStatus(status: "active" | "achieved") {
    await api.run("status", `/api/iep-goals/${goal.id}`, "PATCH", { status, version: plan.version });
  }
  async function remove() {
    const draft = plan.status === "draft";
    if (!window.confirm(draft ? t("deleteConfirm") : t("discontinueConfirm"))) return;
    await api.run("delete", `/api/iep-goals/${goal.id}?version=${plan.version}`, "DELETE");
  }
  async function record(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const raw = String(data.get("value") ?? "").trim();
    setSaved(false);
    const ok = await api.run("progress", `/api/iep-goals/${goal.id}/progress`, "POST", {
      observed_on: String(data.get("observed_on") ?? ""),
      value: raw === "" ? null : Number(raw),
      ...(String(data.get("note") ?? "").trim() ? { note: String(data.get("note")) } : {}),
    });
    if (ok) {
      form.reset();
      setSaved(true);
    }
  }

  return (
    <li className="space-y-3 rounded border border-slate-200 bg-white p-4" data-goal={goal.id} aria-labelledby={headingId}>
      <div className="flex flex-wrap items-center gap-2 text-xs font-medium">
        <Badge>{td(DOMAIN_KEYS[goal.domain])}</Badge>
        <Badge tone={GOAL_STATUS_TONES[goal.status]}>{tg(goal.status)}</Badge>
      </div>
      {editing ? (
        <GoalForm
          plan={plan}
          initial={goal}
          busy={api.busy === "edit"}
          fields={api.problem?.fields ?? {}}
          submitLabel={t("save")}
          onSubmit={save}
          onCancel={() => {
            setEditing(false);
            api.setProblem(null);
          }}
        />
      ) : (
        <>
          <h4 id={headingId} className="font-semibold break-words">
            {t("number", { n: index + 1 })} {goal.statement}
          </h4>
          <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[max-content_1fr]">
            {(
              [
                ["specific", t("specific")],
                ["measurable", t("measurable")],
                ["achievable", t("achievable")],
                ["relevant", t("relevant")],
                ["time_bound", t("timeBound")],
              ] as const
            ).map(([key, label]) => (
              <div key={key} className="contents">
                <dt className="font-medium text-slate-700">{label}</dt>
                <dd className="break-words text-slate-900">{goal[key]}</dd>
              </div>
            ))}
            <dt className="font-medium text-slate-700">{t("measureType")}</dt>
            <dd>{tm(MEASURE_KEYS[goal.measure_type])}</dd>
            <dt className="font-medium text-slate-700">{t("baselineToTarget")}</dt>
            <dd>
              {t("baselineToTargetValue", {
                baseline: value(goal.baseline_value),
                target: value(goal.target_value),
                date: day(goal.target_date),
              })}
            </dd>
          </dl>
        </>
      )}

      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,16rem)]">
        <ProgressChart
          id={`chart-${goal.id}`}
          measure={goal.measure_type}
          baseline={goal.baseline_value}
          target={goal.target_value}
          baselineLabel={value(goal.baseline_value)}
          targetLabel={value(goal.target_value)}
          points={goal.progress.map((p) => ({
            observed_on: p.observed_on,
            value: p.value,
            dateLabel: day(p.observed_on),
            valueLabel: value(p.value),
            note: p.note,
          }))}
          labels={{
            title: tc("title", { goal: goal.statement }),
            baseline: tc("baseline"),
            target: tc("target"),
            showData: tc("showData"),
            date: tc("date"),
            value: tc("value"),
            note: tc("note"),
            noData: tc("noData"),
          }}
        />
        <ul className="space-y-1 text-sm text-slate-800" aria-label={tt("label")} data-trend={goal.id}>
          {trendLines(tt, value, format, goal.trend).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </div>

      {!closed && goal.status !== "discontinued" ? (
        <form onSubmit={record} className="grid gap-2 rounded bg-slate-50 p-3 sm:grid-cols-[auto_auto_1fr_auto]" noValidate>
          <p className="text-sm font-semibold sm:col-span-4">{tpr("record")}</p>
          <Field name="observed_on" label={tpr("date")} error={api.problem?.fields.observed_on}>
            {(p) => <input {...p} type="date" name="observed_on" required max={today} defaultValue={today} className={inputClass} />}
          </Field>
          <Field name="value" label={tpr("value")} error={api.problem?.fields.value}>
            {(p) => (
              <input
                {...p}
                type="number"
                inputMode="decimal"
                name="value"
                required
                min={range.min}
                {...(range.max !== null ? { max: range.max } : {})}
                step={range.integer ? 1 : "any"}
                className={`${inputClass} w-28`}
              />
            )}
          </Field>
          <Field name="note" label={tpr("note")} error={api.problem?.fields.note}>
            {(p) => <input {...p} name="note" maxLength={500} className={inputClass} />}
          </Field>
          <div className="flex items-end">
            <Button type="submit" disabled={api.busy !== null}>
              {api.busy === "progress" ? tpr("saving") : tpr("save")}
            </Button>
          </div>
          {saved ? (
            <p role="status" className="text-sm font-medium text-emerald-800 sm:col-span-4">
              {tpr("saved")}
            </p>
          ) : null}
        </form>
      ) : null}

      <ErrorText problem={api.problem} onReload={api.refresh} />

      {!closed && !editing ? (
        <div className="flex flex-wrap gap-2">
          <button type="button" className={smallButton} onClick={() => setEditing(true)} disabled={api.busy !== null}>
            {t("edit")}
          </button>
          {goal.status === "active" ? (
            <button type="button" className={smallButton} onClick={() => setStatus("achieved")} disabled={api.busy !== null}>
              {t("markAchieved")}
            </button>
          ) : (
            <button type="button" className={smallButton} onClick={() => setStatus("active")} disabled={api.busy !== null}>
              {t("reopen")}
            </button>
          )}
          {plan.status === "draft" || goal.status !== "discontinued" ? (
            <button type="button" className={smallButton} onClick={remove} disabled={api.busy !== null}>
              {plan.status === "draft" ? t("delete") : t("discontinue")}
            </button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

// ---------------------------------------------------------------------------------------------------------

export function GoalsPanel({
  caseId,
  plans,
  plan,
  goals,
  today,
}: {
  caseId: string;
  plans: PlanOption[];
  plan: PlanSummary | null;
  goals: GoalWithProgress[];
  today: string;
}) {
  const t = useT("iep.provider");
  const ts = useT("iep.statuses");
  const format = useFormatter();
  const createApi = useApi();
  const planApi = useApi();
  const goalApi = useApi();
  const router = useRouter();
  const [editingPlan, setEditingPlan] = useState(false);
  const [published, setPublished] = useState(false);
  const closed = plan ? plan.status === "completed" || plan.status === "archived" : false;
  const day = (d: string) => format.date(`${d}T12:00:00+05:30`, "long");

  async function create(values: { title: string; start_date: string; review_date: string }, form: HTMLFormElement) {
    const data = await createApi.run<{ plan: { id: string } }>("create", `/api/cases/${caseId}/iep-plans`, "POST", values);
    if (data) {
      form.reset();
      router.push(`/cases/${caseId}/goals?plan=${data.plan.id}`);
    }
  }
  async function savePlan(values: { title: string; start_date: string; review_date: string }) {
    if (!plan) return;
    const ok = await planApi.run("edit", `/api/iep-plans/${plan.id}`, "PATCH", { ...values, version: plan.version });
    if (ok) setEditingPlan(false);
  }
  async function setPlanStatus(status: "completed" | "archived") {
    if (!plan) return;
    if (!window.confirm(status === "archived" ? t("archiveConfirm") : t("completeConfirm"))) return;
    await planApi.run(status, `/api/iep-plans/${plan.id}`, "PATCH", { status, version: plan.version });
  }
  async function publish() {
    if (!plan) return;
    setPublished(false);
    const ok = await planApi.run("publish", `/api/iep-plans/${plan.id}/publish`, "POST", { version: plan.version });
    if (ok) setPublished(true);
  }
  async function addGoal(values: GoalFormValues, form: HTMLFormElement) {
    if (!plan) return;
    const ok = await goalApi.run("add", `/api/iep-plans/${plan.id}/goals`, "POST", { ...values, version: plan.version });
    if (ok) {
      form.reset();
      (form.closest("details") as HTMLDetailsElement | null)?.removeAttribute("open");
    }
  }

  const canPublish = plan && !closed && (!plan.published || plan.has_unpublished_changes || plan.status === "draft");

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">{t("title")}</h2>
        <p className="text-sm text-slate-700">{t("intro")}</p>
      </div>

      {plans.length > 1 ? (
        <nav aria-label={t("plansLabel")} className="flex flex-wrap gap-2">
          {plans.map((p) => (
            <Link
              key={p.id}
              href={`/cases/${caseId}/goals?plan=${p.id}`}
              aria-current={plan?.id === p.id ? "page" : undefined}
              className={`inline-flex min-h-9 items-center gap-2 rounded border px-3 py-1 text-sm ${
                plan?.id === p.id ? "border-slate-900 font-semibold" : "border-slate-300"
              }`}
            >
              <span className="break-words">{p.title}</span>
              <Badge tone={PLAN_STATUS_TONES[p.status]}>{ts(p.status)}</Badge>
            </Link>
          ))}
        </nav>
      ) : null}

      <details className="rounded border border-slate-200 bg-white p-4" open={plans.length === 0}>
        <summary className="cursor-pointer font-semibold">{t("newPlan")}</summary>
        <div className="mt-3 space-y-2">
          {plan?.status === "active" ? <p className="text-sm text-slate-700">{t("publishHint")}</p> : null}
          <PlanForm
            submitLabel={t("create")}
            busyLabel={t("creating")}
            busy={createApi.busy !== null}
            fields={createApi.problem?.fields ?? {}}
            onSubmit={create}
          />
          <ErrorText problem={createApi.problem} onReload={createApi.refresh} />
        </div>
      </details>

      {!plan ? (
        <p className="text-slate-700">{t("empty")}</p>
      ) : (
        <section aria-labelledby="plan-title" className="space-y-4" data-plan={plan.id}>
          <header className="space-y-2 rounded border border-slate-200 bg-white p-4">
            {editingPlan ? (
              <PlanForm
                submitLabel={t("save")}
                busyLabel={t("saving")}
                initial={plan}
                busy={planApi.busy === "edit"}
                fields={planApi.problem?.fields ?? {}}
                onSubmit={savePlan}
                onCancel={() => {
                  setEditingPlan(false);
                  planApi.setProblem(null);
                }}
              />
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <h3 id="plan-title" className="text-lg font-semibold break-words">
                    {plan.title}
                  </h3>
                  <Badge tone={PLAN_STATUS_TONES[plan.status]} data-plan-status={plan.status}>
                    {ts(plan.status)}
                  </Badge>
                  {plan.has_unpublished_changes ? (
                    <Badge tone="warning" data-unpublished="true">
                      {t("unpublishedChanges")}
                    </Badge>
                  ) : null}
                </div>
                <p className="text-sm text-slate-700">{t("dates", { start: day(plan.start_date), review: day(plan.review_date) })}</p>
                <p className="text-sm text-slate-700">
                  {plan.published
                    ? t("publishedInfo", { version: plan.published.version, date: format.date(plan.published.published_at, "long") })
                    : t("notPublished")}
                </p>
              </>
            )}
            {closed ? <p className="text-sm font-medium text-slate-700">{t("closedNote")}</p> : null}
            {!editingPlan ? (
              <div className="flex flex-wrap gap-2 pt-1">
                {canPublish ? (
                  <Button type="button" onClick={publish} disabled={planApi.busy !== null || goals.length === 0}>
                    {planApi.busy === "publish" ? t("publishing") : plan.published ? t("publishChanges") : t("publishToParent")}
                  </Button>
                ) : plan.published && !closed ? (
                  <p className="self-center text-sm text-slate-700">{t("upToDate")}</p>
                ) : null}
                {!closed ? (
                  <button type="button" className={smallButton} onClick={() => setEditingPlan(true)} disabled={planApi.busy !== null}>
                    {t("editPlan")}
                  </button>
                ) : null}
                {plan.status === "active" ? (
                  <button type="button" className={smallButton} onClick={() => setPlanStatus("completed")} disabled={planApi.busy !== null}>
                    {t("markCompleted")}
                  </button>
                ) : null}
                {plan.status !== "archived" ? (
                  <button type="button" className={smallButton} onClick={() => setPlanStatus("archived")} disabled={planApi.busy !== null}>
                    {t("archive")}
                  </button>
                ) : null}
              </div>
            ) : null}
            {published ? (
              <p role="status" className="text-sm font-medium text-emerald-800">
                {t("published")}
              </p>
            ) : null}
            {goals.length === 0 && !closed ? <p className="text-sm text-slate-600">{t("publishNeedsGoal")}</p> : null}
            <ErrorText problem={planApi.problem} onReload={planApi.refresh} />
          </header>

          <h3 className="font-semibold">{t("goalsLabel")}</h3>
          {goals.length === 0 ? (
            <p className="text-slate-700">{t("noGoals")}</p>
          ) : (
            <ol className="space-y-4" aria-label={t("goalsLabel")}>
              {goals.map((goal, i) => (
                <GoalCard key={goal.id} goal={goal} plan={plan} today={today} index={i} />
              ))}
            </ol>
          )}

          {!closed ? (
            <details className="rounded border border-slate-200 bg-white p-4" open={goals.length === 0}>
              <summary className="cursor-pointer font-semibold">{t("addGoal")}</summary>
              <div className="mt-3 space-y-2">
                <GoalForm
                  plan={plan}
                  busy={goalApi.busy !== null}
                  fields={goalApi.problem?.fields ?? {}}
                  submitLabel={t("addGoal")}
                  onSubmit={addGoal}
                />
                <ErrorText problem={goalApi.problem} onReload={goalApi.refresh} />
              </div>
            </details>
          ) : null}
        </section>
      )}
    </div>
  );
}
