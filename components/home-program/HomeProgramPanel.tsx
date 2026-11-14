"use client";

// Ticket 026 FR-4: case workspace `Home program` tab. Program picker, `Create a home program`, program header
// (status, `Unpublished changes`, `Publish to parent` / `Publish changes`, `Rename`, `Archive`), activities with
// `Edit`, `Stop activity` / `Delete` and the adherence panel (`done <n> of <expected> times in the last 7 days`, last 4
// weeks sparkline, recent guardian notes), `Add activity`. Every write sends the program `version`; a 409 shows the
// reload message.
import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent, type ReactNode } from "react";
import type { ActivityAdherence, GoalOption, GuideOption, ProgramSummary, ProviderActivity } from "@/lib/home-program";
import { useFormatter, useT } from "@/lib/i18n/client";
import { Instructions } from "./Instructions";
import { Sparkline } from "./Sparkline";
import { STATUS_STYLES, sendJson, type HomeProgramErrorKey } from "./view";
import { Button } from "@/components/ui/Button";

const inputClass = "mt-1 block w-full rounded border border-slate-300 px-3 py-2 text-sm";
const labelClass = "block text-sm font-medium text-slate-800";
const smallButton = "min-h-9 rounded border border-slate-300 px-3 py-1 text-sm font-medium text-slate-800 disabled:opacity-50";

type Problem = { error: HomeProgramErrorKey; fields: string[] } | null;

export type ProgramOption = Pick<ProgramSummary, "id" | "title" | "status">;

function useApi() {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<Problem>(null);
  async function run<T>(key: string, url: string, method: string, body?: unknown): Promise<T | null> {
    setBusy(key);
    setProblem(null);
    const result = await sendJson<T>((input, init) => fetch(input, init), url, method, body);
    setBusy(null);
    if (!result.ok) {
      setProblem({ error: result.error, fields: result.fields });
      return null;
    }
    router.refresh();
    return result.data;
  }
  return { busy, problem, run, refresh: () => router.refresh(), push: (href: string) => router.push(href) };
}

function ErrorText({ problem, onReload }: { problem: Problem; onReload: () => void }) {
  const t = useT("homeProgram.errors");
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

function Field({ name, label, hint, invalid, children }: { name: string; label: string; hint?: string; invalid?: boolean; children: (p: { id: string; "aria-invalid"?: boolean; "aria-describedby"?: string }) => ReactNode }) {
  const base = useId();
  const id = `${base}-${name}`;
  return (
    <div>
      <label htmlFor={id} className={labelClass}>
        {label}
      </label>
      {children({ id, ...(invalid ? { "aria-invalid": true } : {}), ...(hint ? { "aria-describedby": `${id}-hint` } : {}) })}
      {hint ? (
        <span id={`${id}-hint`} className="mt-1 block text-xs text-slate-600">
          {hint}
        </span>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------

export type ActivityFormValues = {
  title: string;
  goal_id: string | null;
  instructions_md: string;
  frequency_per_week: number | null;
  duration_min: number | null;
  materials: string | null;
  document_id: string | null;
};

/** Reads the activity form; empty numbers become null so the API answers with a field error. */
export function readActivityForm(data: FormData): ActivityFormValues {
  const num = (name: string) => {
    const raw = String(data.get(name) ?? "").trim();
    return raw === "" || Number.isNaN(Number(raw)) ? null : Number(raw);
  };
  const str = (name: string) => String(data.get(name) ?? "");
  return {
    title: str("title"),
    goal_id: str("goal_id") || null,
    instructions_md: str("instructions_md"),
    frequency_per_week: num("frequency_per_week"),
    duration_min: num("duration_min"),
    materials: str("materials").trim() || null,
    document_id: str("document_id") || null,
  };
}

function ActivityForm({
  initial,
  goals,
  guides,
  busy,
  fields,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial?: ProviderActivity;
  goals: GoalOption[];
  guides: GuideOption[];
  busy: boolean;
  fields: string[];
  submitLabel: string;
  onSubmit: (values: ActivityFormValues, form: HTMLFormElement) => void;
  onCancel?: () => void;
}) {
  const t = useT("homeProgram.fields");
  const tp = useT("homeProgram.provider");
  const goalChoices =
    initial?.goal_id && !goals.some((g) => g.id === initial.goal_id)
      ? [...goals, { id: initial.goal_id, statement: initial.goal_statement ?? initial.goal_id, domain: "" }]
      : goals;
  const guideChoices =
    initial?.document_id && !guides.some((g) => g.id === initial.document_id)
      ? [...guides, { id: initial.document_id, title: initial.document_title ?? initial.document_id, file_name: "", mime_type: "" }]
      : guides;
  const bad = (name: string) => fields.includes(name);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit(readActivityForm(new FormData(event.currentTarget)), event.currentTarget);
  }

  return (
    <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2" noValidate>
      <div className="sm:col-span-2">
        <Field name="title" label={t("activity")} invalid={bad("title")}>
          {(p) => <input {...p} name="title" required maxLength={120} defaultValue={initial?.title} className={inputClass} />}
        </Field>
      </div>
      <div className="sm:col-span-2">
        <Field name="goal_id" label={t("goal")} invalid={bad("goal_id")} hint={goals.length === 0 ? t("noPlan") : undefined}>
          {(p) => (
            <select {...p} name="goal_id" defaultValue={initial?.goal_id ?? ""} className={inputClass}>
              <option value="">{t("noGoal")}</option>
              {goalChoices.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.statement}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
      <div className="sm:col-span-2">
        <Field name="instructions_md" label={t("instructions")} hint={t("instructionsHint")} invalid={bad("instructions_md")}>
          {(p) => (
            <textarea {...p} name="instructions_md" required maxLength={4000} rows={4} defaultValue={initial?.instructions_md} className={inputClass} />
          )}
        </Field>
      </div>
      <Field name="frequency_per_week" label={t("frequency")} invalid={bad("frequency_per_week")}>
        {(p) => (
          <input {...p} type="number" inputMode="numeric" name="frequency_per_week" required min={1} max={14} step={1} defaultValue={initial?.frequency_per_week ?? 5} className={inputClass} />
        )}
      </Field>
      <Field name="duration_min" label={t("duration")} invalid={bad("duration_min")}>
        {(p) => (
          <input {...p} type="number" inputMode="numeric" name="duration_min" required min={1} max={120} step={1} defaultValue={initial?.duration_min ?? 10} className={inputClass} />
        )}
      </Field>
      <div className="sm:col-span-2">
        <Field name="materials" label={t("materials")} invalid={bad("materials")}>
          {(p) => <textarea {...p} name="materials" maxLength={500} rows={2} defaultValue={initial?.materials ?? ""} className={inputClass} />}
        </Field>
      </div>
      <div className="sm:col-span-2">
        <Field name="document_id" label={t("guide")} hint={t("guideHint")} invalid={bad("document_id")}>
          {(p) => (
            <select {...p} name="document_id" defaultValue={initial?.document_id ?? ""} className={inputClass}>
              <option value="">{t("noGuide")}</option>
              {guideChoices.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.title}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
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

function AdherencePanel({ adherence, timeZone }: { adherence: ActivityAdherence; timeZone: string }) {
  const t = useT("homeProgram.adherence");
  const td = useT("homeProgram.difficulty");
  const format = useFormatter();
  const day = (d: string) => format.date(`${d}T12:00:00Z`, "short");
  const weekLabels = adherence.weeks.map((w) => t("week", { date: day(w.week_start), done: w.done, expected: w.expected }));
  return (
    <div className="space-y-2 rounded border border-slate-200 bg-slate-50 p-3" data-adherence={adherence.activity_id}>
      <h4 className="text-sm font-semibold text-slate-900">{t("title")}</h4>
      <p className="text-sm font-medium text-slate-900" data-last7={adherence.activity_id}>
        {t("last7", { done: adherence.last_7_days.done, expected: adherence.last_7_days.expected })}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-xs text-slate-600">{t("weeks")}</span>
        <Sparkline weeks={adherence.weeks} label={`${t("weeks")}: ${weekLabels.join("; ")}`} />
      </div>
      <p className="text-xs text-slate-600">{t("timeZone", { zone: timeZone })}</p>
      <div>
        <h5 className="text-sm font-medium text-slate-800">{t("notes")}</h5>
        {adherence.recent_notes.length === 0 ? (
          <p className="text-sm text-slate-600">{t("noNotes")}</p>
        ) : (
          <ul className="mt-1 space-y-1">
            {adherence.recent_notes.map((n) => (
              <li key={n.id} className="text-sm text-slate-800" data-note={n.id}>
                <span className="text-xs text-slate-600">{t("noteMeta", { date: day(n.done_on), difficulty: td(n.difficulty) })}</span>
                {n.logged_by_name ? <span className="text-xs text-slate-600"> · {n.logged_by_name}</span> : null}
                <span className="block break-words whitespace-pre-wrap">{n.note}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function ActivityCard({
  activity,
  adherence,
  program,
  goals,
  guides,
  timeZone,
}: {
  activity: ProviderActivity;
  adherence?: ActivityAdherence;
  program: ProgramSummary;
  goals: GoalOption[];
  guides: GuideOption[];
  timeZone: string;
}) {
  const tp = useT("homeProgram.provider");
  const tf = useT("homeProgram.fields");
  const api = useApi();
  const [editing, setEditing] = useState(false);
  const readOnly = program.status === "archived";

  async function save(values: ActivityFormValues) {
    const done = await api.run(`edit`, `/api/home-activities/${activity.id}`, "PATCH", { ...values, version: program.version });
    if (done) setEditing(false);
  }

  return (
    <li className="space-y-3 rounded-lg border border-slate-200 bg-white p-4" data-activity={activity.id}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-1">
          <h3 className="font-semibold break-words text-slate-900">
            {activity.title}
            {!activity.active ? <span className="ml-2 rounded bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">{tp("stopped")}</span> : null}
          </h3>
          <p className="text-sm text-slate-700">{tp("summary", { count: activity.frequency_per_week, minutes: activity.duration_min })}</p>
          {activity.goal_statement ? <p className="text-sm text-slate-700">{tp("goalLabel", { goal: activity.goal_statement })}</p> : null}
          {activity.materials ? <p className="text-sm break-words text-slate-700">{tp("materialsLabel", { materials: activity.materials })}</p> : null}
          {activity.document_title ? <p className="text-sm text-slate-700">{tp("guideLabel", { title: activity.document_title })}</p> : null}
        </div>
        {!readOnly ? (
          <div className="flex flex-wrap gap-2">
            <button type="button" className={smallButton} onClick={() => setEditing((v) => !v)} aria-expanded={editing}>
              {tp("edit")}
            </button>
            {program.status === "draft" ? (
              <button type="button" className={smallButton} disabled={api.busy !== null} onClick={() => api.run("delete", `/api/home-activities/${activity.id}?version=${program.version}`, "DELETE")}>
                {tp("delete")}
              </button>
            ) : activity.active ? (
              <button type="button" className={smallButton} disabled={api.busy !== null} onClick={() => api.run("stop", `/api/home-activities/${activity.id}?version=${program.version}`, "DELETE")}>
                {tp("stop")}
              </button>
            ) : (
              <button type="button" className={smallButton} disabled={api.busy !== null} onClick={() => api.run("restart", `/api/home-activities/${activity.id}`, "PATCH", { active: true, version: program.version })}>
                {tp("restart")}
              </button>
            )}
          </div>
        ) : null}
      </div>
      <Instructions markdown={activity.instructions_md} label={tf("instructions")} />
      <ErrorText problem={api.problem} onReload={api.refresh} />
      {editing ? (
        <ActivityForm
          initial={activity}
          goals={goals}
          guides={guides}
          busy={api.busy === "edit"}
          fields={api.problem?.fields ?? []}
          submitLabel={tp("save")}
          onSubmit={save}
          onCancel={() => setEditing(false)}
        />
      ) : null}
      {adherence && program.published ? <AdherencePanel adherence={adherence} timeZone={timeZone} /> : null}
    </li>
  );
}

// ---------------------------------------------------------------------------------------------------------

function CreateProgram({ caseId, open }: { caseId: string; open: boolean }) {
  const tp = useT("homeProgram.provider");
  const api = useApi();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const title = String(new FormData(form).get("title") ?? "");
    const created = await api.run<{ program: { id: string } }>("create", `/api/cases/${caseId}/home-programs`, "POST", { title });
    if (created) {
      form.reset();
      api.push(`/cases/${caseId}/home-program?program=${created.program.id}`);
    }
  }
  const body = (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-2" noValidate>
      <Field name="new-title" label={tp("programTitle")} invalid={api.problem?.fields.includes("title")}>
        {(p) => <input {...p} name="title" required maxLength={120} className={`${inputClass} min-w-64`} />}
      </Field>
      <Button type="submit" disabled={api.busy !== null}>
        {api.busy ? tp("saving") : tp("create")}
      </Button>
      <ErrorText problem={api.problem} onReload={api.refresh} />
    </form>
  );
  if (open) return body;
  return (
    <details className="rounded border border-slate-200 bg-white p-3">
      <summary className="cursor-pointer text-sm font-medium text-slate-800">{tp("create")}</summary>
      <div className="mt-3">{body}</div>
    </details>
  );
}

export function HomeProgramPanel({
  caseId,
  programs,
  program,
  activities,
  adherence,
  goals,
  guides,
  timeZone,
}: {
  caseId: string;
  programs: ProgramOption[];
  program: ProgramSummary | null;
  activities: ProviderActivity[];
  adherence: ActivityAdherence[];
  goals: GoalOption[];
  guides: GuideOption[];
  timeZone: string;
}) {
  const tp = useT("homeProgram.provider");
  const ts = useT("homeProgram.status");
  const format = useFormatter();
  const api = useApi();
  const [renaming, setRenaming] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [formKey, setFormKey] = useState(0);
  const pickerId = useId();

  async function publish() {
    if (!program) return;
    setMessage(null);
    const done = await api.run("publish", `/api/home-programs/${program.id}/publish`, "POST", { version: program.version });
    if (done) setMessage(tp("published"));
  }

  async function addActivity(values: ActivityFormValues) {
    if (!program) return;
    const done = await api.run("add", `/api/home-programs/${program.id}/activities`, "POST", { ...values, version: program.version });
    if (done) setFormKey((k) => k + 1);
  }

  async function rename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!program) return;
    const title = String(new FormData(event.currentTarget).get("title") ?? "");
    const done = await api.run("rename", `/api/home-programs/${program.id}`, "PATCH", { title, version: program.version });
    if (done) setRenaming(false);
  }

  return (
    <section aria-labelledby="home-program-heading" className="space-y-6">
      <header className="space-y-1">
        <h2 id="home-program-heading" className="text-xl font-semibold text-slate-900">
          {tp("title")}
        </h2>
        <p className="text-sm text-slate-700">{tp("intro")}</p>
      </header>

      {programs.length > 1 && program ? (
        <div>
          <label htmlFor={pickerId} className={labelClass}>
            {tp("choose")}
          </label>
          <select
            id={pickerId}
            className={`${inputClass} max-w-md`}
            value={program.id}
            onChange={(e) => api.push(`/cases/${caseId}/home-program?program=${e.target.value}`)}
          >
            {programs.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title} ({ts(p.status)})
              </option>
            ))}
          </select>
        </div>
      ) : null}

      {!program ? (
        <div className="space-y-3">
          <p className="text-sm text-slate-700">{tp("empty")}</p>
          <CreateProgram caseId={caseId} open />
        </div>
      ) : (
        <>
          <div className="space-y-3 rounded-lg border border-slate-200 bg-white p-4" data-program={program.id}>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-lg font-semibold break-words text-slate-900">{program.title}</h3>
              <span className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[program.status]}`}>{ts(program.status)}</span>
              {program.has_unpublished_changes ? (
                <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900" data-badge="unpublished">
                  {tp("unpublished")}
                </span>
              ) : null}
            </div>
            <p className="text-sm text-slate-600">
              {program.published
                ? tp("publishedOn", { version: program.published.version, date: format.date(program.published.published_at, "long") })
                : tp("notPublished")}
            </p>
            {program.status === "archived" ? (
              <p className="text-sm text-slate-700">{tp("readOnly")}</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {program.status === "draft" || program.has_unpublished_changes ? (
                  <Button type="button" disabled={api.busy !== null} onClick={publish}>
                    {api.busy === "publish" ? tp("publishing") : program.status === "draft" ? tp("publish") : tp("publishChanges")}
                  </Button>
                ) : null}
                <button type="button" className={smallButton} onClick={() => setRenaming((v) => !v)} aria-expanded={renaming}>
                  {tp("rename")}
                </button>
                <button
                  type="button"
                  className={smallButton}
                  disabled={api.busy !== null}
                  onClick={() => api.run("archive", `/api/home-programs/${program.id}`, "PATCH", { status: "archived", version: program.version })}
                >
                  {tp("archive")}
                </button>
              </div>
            )}
            {renaming ? (
              <form onSubmit={rename} className="flex flex-wrap items-end gap-2" noValidate>
                <Field name="rename" label={tp("programTitle")}>
                  {(p) => <input {...p} name="title" required maxLength={120} defaultValue={program.title} className={`${inputClass} min-w-64`} />}
                </Field>
                <Button type="submit" disabled={api.busy !== null}>
                  {api.busy === "rename" ? tp("saving") : tp("save")}
                </Button>
              </form>
            ) : null}
            {message ? (
              <p role="status" className="text-sm font-medium text-emerald-800">
                {message}
              </p>
            ) : null}
            <ErrorText problem={api.problem} onReload={api.refresh} />
          </div>

          <div className="space-y-3">
            <h3 className="text-lg font-semibold text-slate-900">{tp("activities")}</h3>
            {activities.length === 0 ? <p className="text-sm text-slate-700">{tp("noActivities")}</p> : null}
            {activities.some((a) => !a.active) ? <p className="text-xs text-slate-600">{tp("stoppedHint")}</p> : null}
            <ol className="space-y-3">
              {activities.map((a) => (
                <ActivityCard
                  key={a.id}
                  activity={a}
                  adherence={adherence.find((x) => x.activity_id === a.id)}
                  program={program}
                  goals={goals}
                  guides={guides}
                  timeZone={timeZone}
                />
              ))}
            </ol>
          </div>

          {program.status !== "archived" ? (
            <div className="space-y-3 rounded-lg border border-slate-200 bg-white p-4">
              <h3 className="text-lg font-semibold text-slate-900">{tp("addActivity")}</h3>
              <ActivityForm
                key={formKey}
                goals={goals}
                guides={guides}
                busy={api.busy === "add"}
                fields={api.busy === null && api.problem ? api.problem.fields : []}
                submitLabel={tp("addActivity")}
                onSubmit={addActivity}
              />
            </div>
          ) : null}

          <CreateProgram caseId={caseId} open={false} />
        </>
      )}
    </section>
  );
}
