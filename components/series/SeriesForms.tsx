"use client";

import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent, type ReactNode } from "react";
import { useT } from "@/lib/i18n/client";
import { fieldKeys, inputClass, labelClass, secondaryButtonClass, send } from "@/components/providers/request";
import { timeToMinutes, wallToUtc } from "@/lib/booking/time";
import { Button } from "@/components/ui/Button";

// 043 staff forms: new weekly timetable (case page), "This and future sessions" / Pause / End, "This session only"
// Move (030's reschedule route), and the Conflicts actions (`Pick another time` / `Skip this date`). Each form posts
// to /api/provider/series/** (or 030's /api/appointments/**) and refreshes the page.

export type TherapistOption = {
  profile_id: string;
  name: string;
  services: { id: string; name: string; mode: "in_clinic" | "video"; duration_min: number; location_name: string | null }[];
};

const ERROR_KEYS = [
  "slot_taken",
  "blocked_date",
  "outside_hours",
  "too_soon",
  "case_required",
  "service_invalid",
  "starts_in_past",
  "pause_exists",
  "already_resolved",
  "invalid_transition",
  "slot_unavailable",
  "too_far",
  "too_late",
] as const;
type ErrorKey = (typeof ERROR_KEYS)[number];
const WEEKDAY_KEYS = ["0", "1", "2", "3", "4", "5", "6"] as const;
const selectClass = `${inputClass} min-h-11`;

function useAction() {
  const t = useT("series.timetable");
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [invalid, setInvalid] = useState<string[]>([]);

  async function run(url: string, body: unknown, okText?: (json: Record<string, unknown>) => string): Promise<boolean> {
    setBusy(true);
    setMessage(null);
    setInvalid([]);
    const res = await send(url, "POST", body);
    setBusy(false);
    if (res.ok) {
      setMessage({ kind: "ok", text: okText ? okText(res.json) : t("saved") });
      router.refresh();
      return true;
    }
    const code = res.json.code as string | undefined;
    setInvalid(fieldKeys(res.json));
    const known = (ERROR_KEYS as readonly string[]).includes(code ?? "");
    setMessage({ kind: "error", text: known ? t(`errors.${code as ErrorKey}`) : res.status === 400 ? t("invalid") : t("failed") });
    return false;
  }

  const feedback = message ? (
    <p role={message.kind === "error" ? "alert" : "status"} className={`w-full text-sm ${message.kind === "error" ? "text-red-700" : "text-teal-800"}`}>
      {message.text}
    </p>
  ) : null;
  return { busy, run, feedback, bad: (field: string) => invalid.includes(field) || undefined };
}

/** The instant of `date` + `time` on the clinic's wall clock (null for an invalid / DST-skipped time). */
function clinicInstant(date: string, time: string, timeZone: string): string | null {
  if (!date || !time) return null;
  const at = wallToUtc(date, timeToMinutes(time), timeZone);
  return at ? at.toISOString() : null;
}

function WeekdayPicker({ defaultValue, invalid }: { defaultValue: number[]; invalid?: boolean }) {
  const t = useT("booking.schedule");
  const ts = useT("series.timetable");
  return (
    <fieldset className="sm:col-span-2">
      <legend className={labelClass}>{ts("weekdays")}</legend>
      <div className="mt-1 flex flex-wrap gap-2">
        {WEEKDAY_KEYS.map((k) => (
          <label key={k} className={`inline-flex min-h-11 items-center gap-2 rounded border bg-white px-3 text-sm ${invalid ? "border-red-600" : "border-slate-300"}`}>
            <input type="checkbox" name="weekdays" value={k} defaultChecked={defaultValue.includes(Number(k))} className="h-4 w-4" />
            {t(`weekdays.${k}`)}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function TherapistServiceFields(props: {
  therapists: TherapistOption[];
  profileId: string;
  serviceId: string;
  onProfile: (id: string) => void;
  onService: (id: string) => void;
  bad: (field: string) => true | undefined;
  idPrefix: string;
}) {
  const t = useT("series.timetable");
  const tb = useT("booking");
  const services = props.therapists.find((x) => x.profile_id === props.profileId)?.services ?? [];
  return (
    <>
      <div>
        <label htmlFor={`${props.idPrefix}-therapist`} className={labelClass}>{t("therapist")}</label>
        <select
          id={`${props.idPrefix}-therapist`}
          value={props.profileId}
          onChange={(e) => {
            props.onProfile(e.target.value);
            props.onService(props.therapists.find((x) => x.profile_id === e.target.value)?.services[0]?.id ?? "");
          }}
          className={selectClass}
          aria-invalid={props.bad("provider_profile_id")}
        >
          {props.therapists.map((x) => (
            <option key={x.profile_id} value={x.profile_id}>{x.name}</option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor={`${props.idPrefix}-service`} className={labelClass}>{t("service")}</label>
        <select
          id={`${props.idPrefix}-service`}
          value={props.serviceId}
          onChange={(e) => props.onService(e.target.value)}
          className={selectClass}
          aria-invalid={props.bad("service_id")}
        >
          {services.map((s) => (
            <option key={s.id} value={s.id}>
              {[s.name, tb("duration", { minutes: s.duration_min }), tb(`modes.${s.mode}`), s.location_name].filter(Boolean).join(" · ")}
            </option>
          ))}
        </select>
      </div>
    </>
  );
}

const weekdaysOf = (f: FormData) => f.getAll("weekdays").map((v) => Number(v));

/** FR-6 new series form on the case page (therapist, service, weekdays, time, start/end date, billing mode). */
export function NewSeriesForm(props: { caseId: string; therapists: TherapistOption[]; hasGuardian: boolean; today: string; timeZone: string }) {
  const t = useT("series.timetable");
  const id = useId();
  const { busy, run, feedback, bad } = useAction();
  const [profileId, setProfileId] = useState(props.therapists[0]?.profile_id ?? "");
  const [serviceId, setServiceId] = useState(props.therapists[0]?.services[0]?.id ?? "");

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const endsOn = String(f.get("ends_on") ?? "");
    await run(
      "/api/provider/series",
      {
        case_id: props.caseId,
        provider_profile_id: profileId,
        service_id: serviceId,
        weekdays: weekdaysOf(f),
        start_time: String(f.get("start_time") ?? ""),
        starts_on: String(f.get("starts_on") ?? ""),
        ...(endsOn ? { ends_on: endsOn } : {}),
        billing_mode: String(f.get("billing_mode") ?? "per_session"),
        notify_family: props.hasGuardian ? f.get("notify_family") === "on" : false,
      },
      (json) => t("createdSummary", { created: Number(json.created ?? 0), conflicts: Array.isArray(json.conflicts) ? json.conflicts.length : 0 }),
    );
  }

  return (
    <form onSubmit={submit} className="grid gap-3 rounded border border-slate-200 bg-slate-50 p-3 sm:grid-cols-2" aria-labelledby={`${id}-h`}>
      <h3 id={`${id}-h`} className="text-base font-semibold text-slate-900 sm:col-span-2">{t("add")}</h3>
      <TherapistServiceFields
        therapists={props.therapists}
        profileId={profileId}
        serviceId={serviceId}
        onProfile={setProfileId}
        onService={setServiceId}
        bad={bad}
        idPrefix={id}
      />
      <WeekdayPicker defaultValue={[]} invalid={bad("weekdays")} />
      <div>
        <label htmlFor={`${id}-time`} className={labelClass}>{t("time")}</label>
        <input id={`${id}-time`} name="start_time" type="time" required defaultValue="10:00" className={inputClass} aria-invalid={bad("start_time")} aria-describedby={`${id}-tz`} />
        <p id={`${id}-tz`} className="mt-1 text-xs text-slate-600">{t("timeZoneNote", { zone: props.timeZone })}</p>
      </div>
      <div>
        <label htmlFor={`${id}-billing`} className={labelClass}>{t("billing")}</label>
        <select id={`${id}-billing`} name="billing_mode" defaultValue="per_session" className={selectClass}>
          {(["per_session", "package", "free"] as const).map((m) => (
            <option key={m} value={m}>{t(`billingModes.${m}`)}</option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor={`${id}-starts`} className={labelClass}>{t("startsOn")}</label>
        <input id={`${id}-starts`} name="starts_on" type="date" required min={props.today} defaultValue={props.today} className={inputClass} aria-invalid={bad("starts_on")} />
      </div>
      <div>
        <label htmlFor={`${id}-ends`} className={labelClass}>{t("endsOn")}</label>
        <input id={`${id}-ends`} name="ends_on" type="date" min={props.today} className={inputClass} aria-invalid={bad("ends_on")} />
      </div>
      {props.hasGuardian ? (
        <label className="inline-flex min-h-11 items-center gap-2 text-sm text-slate-800 sm:col-span-2">
          <input type="checkbox" name="notify_family" defaultChecked className="h-4 w-4" />
          {t("notifyFamily")}
        </label>
      ) : (
        <p role="note" className="rounded bg-sky-50 p-2 text-sm text-sky-900 sm:col-span-2">{t("noGuardian")}</p>
      )}
      <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
        <Button type="submit" disabled={busy || !serviceId}>{t("create")}</Button>
        {feedback}
      </div>
    </form>
  );
}

function Toggle({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const t = useT("series.timetable");
  return open ? (
    <div className="w-full space-y-2 rounded border border-slate-200 bg-slate-50 p-3">
      {children}
      <button type="button" className={secondaryButtonClass} onClick={() => setOpen(false)}>{t("close")}</button>
    </div>
  ) : (
    <button type="button" className={secondaryButtonClass} onClick={() => setOpen(true)} aria-expanded={false}>
      {label}
    </button>
  );
}

/** FR-5 series-level actions: "This and future sessions", Pause (date range), End. */
export function SeriesActions(props: {
  seriesId: string;
  therapists: TherapistOption[];
  current: { profile_id: string; service_id: string | null; weekdays: number[]; start_time: string };
  today: string;
  timeZone: string;
}) {
  const t = useT("series.timetable");
  const id = useId();
  const change = useAction();
  const pause = useAction();
  const end = useAction();
  const known = props.therapists.some((x) => x.profile_id === props.current.profile_id);
  const [profileId, setProfileId] = useState(known ? props.current.profile_id : "");
  const [serviceId, setServiceId] = useState(known ? (props.current.service_id ?? "") : "");

  async function submitChange(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const switched = Boolean(profileId && serviceId) && (profileId !== props.current.profile_id || serviceId !== props.current.service_id);
    await change.run(`/api/provider/series/${props.seriesId}/change`, {
      from: String(f.get("from") ?? ""),
      weekdays: weekdaysOf(f),
      start_time: String(f.get("start_time") ?? ""),
      ...(switched ? { provider_profile_id: profileId, service_id: serviceId } : {}),
    });
  }

  async function submitPause(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await pause.run(`/api/provider/series/${props.seriesId}/pause`, { from: String(f.get("from") ?? ""), to: String(f.get("to") ?? "") });
  }

  async function submitEnd(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await end.run(`/api/provider/series/${props.seriesId}/end`, { ends_on: String(f.get("ends_on") || props.today) });
  }

  return (
    <div className="flex flex-wrap gap-2">
      <Toggle label={t("changeFuture")}>
        <form onSubmit={submitChange} className="grid gap-3 sm:grid-cols-2" aria-label={t("changeFuture")}>
          <div>
            <label htmlFor={`${id}-from`} className={labelClass}>{t("changeFrom")}</label>
            <input id={`${id}-from`} name="from" type="date" required min={props.today} defaultValue={props.today} className={inputClass} aria-invalid={change.bad("from")} />
          </div>
          <div>
            <label htmlFor={`${id}-ctime`} className={labelClass}>{t("time")}</label>
            <input id={`${id}-ctime`} name="start_time" type="time" required defaultValue={props.current.start_time} className={inputClass} aria-invalid={change.bad("start_time")} />
            <p className="mt-1 text-xs text-slate-600">{t("timeZoneNote", { zone: props.timeZone })}</p>
          </div>
          {known ? (
            <TherapistServiceFields
              therapists={props.therapists}
              profileId={profileId}
              serviceId={serviceId}
              onProfile={setProfileId}
              onService={setServiceId}
              bad={change.bad}
              idPrefix={`${id}-c`}
            />
          ) : null}
          <WeekdayPicker defaultValue={props.current.weekdays} invalid={change.bad("weekdays")} />
          <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
            <Button type="submit" disabled={change.busy}>{t("changeSave")}</Button>
            {change.feedback}
          </div>
        </form>
      </Toggle>
      <Toggle label={t("pause")}>
        <form onSubmit={submitPause} className="grid gap-3 sm:grid-cols-2" aria-label={t("pause")}>
          <div>
            <label htmlFor={`${id}-pfrom`} className={labelClass}>{t("pauseFrom")}</label>
            <input id={`${id}-pfrom`} name="from" type="date" required min={props.today} defaultValue={props.today} className={inputClass} aria-invalid={pause.bad("from")} />
          </div>
          <div>
            <label htmlFor={`${id}-pto`} className={labelClass}>{t("pauseTo")}</label>
            <input id={`${id}-pto`} name="to" type="date" required min={props.today} className={inputClass} aria-invalid={pause.bad("to")} />
          </div>
          <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
            <Button type="submit" disabled={pause.busy}>{t("pauseSave")}</Button>
            {pause.feedback}
          </div>
        </form>
      </Toggle>
      <Toggle label={t("end")}>
        <form onSubmit={submitEnd} className="flex flex-wrap items-end gap-3" aria-label={t("end")}>
          <div>
            <label htmlFor={`${id}-end`} className={labelClass}>{t("endOn")}</label>
            <input id={`${id}-end`} name="ends_on" type="date" required defaultValue={props.today} className={inputClass} aria-invalid={end.bad("ends_on")} />
          </div>
          <Button type="submit" disabled={end.busy}>{t("endSave")}</Button>
          {end.feedback}
        </form>
      </Toggle>
    </div>
  );
}

/** FR-5 "This session only" -> Move: 030's reschedule (a free bookable slot within 14 days, same snapshot). */
export function MoveSessionForm(props: { appointmentId: string; date: string; time: string; timeZone: string }) {
  const t = useT("series.timetable");
  const id = useId();
  const { busy, run, feedback } = useAction();

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const start = clinicInstant(String(f.get("date") ?? ""), String(f.get("time") ?? ""), props.timeZone);
    if (start) await run(`/api/appointments/${props.appointmentId}/reschedule`, { start });
  }

  return (
    <Toggle label={t("move")}>
      <form onSubmit={submit} className="flex flex-wrap items-end gap-3" aria-label={t("move")}>
        <div>
          <label htmlFor={`${id}-d`} className={labelClass}>{t("moveDate")}</label>
          <input id={`${id}-d`} name="date" type="date" required defaultValue={props.date} className={inputClass} />
        </div>
        <div>
          <label htmlFor={`${id}-t`} className={labelClass}>{t("moveTime")}</label>
          <input id={`${id}-t`} name="time" type="time" required defaultValue={props.time} className={inputClass} />
        </div>
        <Button type="submit" disabled={busy}>{t("moveSave")}</Button>
        <p className="w-full text-xs text-slate-600">
          {t("moveHint")} {t("timeZoneNote", { zone: props.timeZone })}
        </p>
        {feedback}
      </form>
    </Toggle>
  );
}

/** FR-6 Conflicts: `Pick another time` (date + time on the clinic's clock) or `Skip this date`. */
export function ConflictActions(props: { conflictId: string; date: string; time: string; timeZone: string }) {
  const t = useT("series.conflicts");
  const tt = useT("series.timetable");
  const id = useId();
  const skip = useAction();
  const pick = useAction();

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const start = clinicInstant(String(f.get("date") ?? ""), String(f.get("time") ?? ""), props.timeZone);
    if (start) await pick.run(`/api/provider/series/conflicts/${props.conflictId}`, { action: "reschedule", start });
  }

  return (
    <div className="flex flex-wrap items-start gap-2">
      <Toggle label={t("pick")}>
        <form onSubmit={submit} className="flex flex-wrap items-end gap-3" aria-label={t("pick")}>
          <div>
            <label htmlFor={`${id}-d`} className={labelClass}>{tt("moveDate")}</label>
            <input id={`${id}-d`} name="date" type="date" required defaultValue={props.date} className={inputClass} />
          </div>
          <div>
            <label htmlFor={`${id}-t`} className={labelClass}>{tt("moveTime")}</label>
            <input id={`${id}-t`} name="time" type="time" required defaultValue={props.time} className={inputClass} />
          </div>
          <Button type="submit" disabled={pick.busy}>{t("pickSave")}</Button>
          <p className="w-full text-xs text-slate-600">{tt("timeZoneNote", { zone: props.timeZone })}</p>
          {pick.feedback}
        </form>
      </Toggle>
      <button
        type="button"
        className={secondaryButtonClass}
        disabled={skip.busy}
        onClick={() => skip.run(`/api/provider/series/conflicts/${props.conflictId}`, { action: "skip" })}
      >
        {t("skip")}
      </button>
      {skip.feedback}
    </div>
  );
}
