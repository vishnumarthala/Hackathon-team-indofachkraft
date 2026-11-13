"use client";

import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { useT } from "@/lib/i18n/client";
import { buttonClass, fieldKeys, inputClass, labelClass, secondaryButtonClass, send } from "@/components/providers/request";

// FR-8 provider schedule editors (`/dashboard/schedule`). Each form posts to /api/provider/** and refreshes the page.

type Loc = { id: string; name: string };
type Org = { id: string; name: string };

function useAction() {
  const t = useT("booking.schedule");
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [invalid, setInvalid] = useState<string[]>([]);

  async function run(url: string, method: string, body?: unknown): Promise<boolean> {
    setBusy(true);
    setMessage(null);
    setInvalid([]);
    const res = await send(url, method, body);
    setBusy(false);
    if (res.ok) {
      setMessage({ kind: "ok", text: t("saved") });
      router.refresh();
      return true;
    }
    setInvalid(fieldKeys(res.json));
    setMessage({ kind: "error", text: res.status === 400 ? t("invalid") : t("failed") });
    return false;
  }

  const feedback = message ? (
    <p role={message.kind === "error" ? "alert" : "status"} className={`text-sm ${message.kind === "error" ? "text-red-700" : "text-teal-800"}`}>
      {message.text}
    </p>
  ) : null;

  return { busy, run, feedback, invalid };
}

const selectClass = `${inputClass} min-h-11`;

export type ServiceItem = {
  id: string;
  name: string;
  mode: "in_clinic" | "video";
  duration_min: number;
  fee_inr: number;
  payment_mode: "online" | "at_clinic" | "free";
  buffer_min: number;
  intake_kind: "child_dev" | "generic" | "none";
  active: boolean;
  location_name: string | null;
};

export function ServicesEditor({ services, locations, orgs }: { services: ServiceItem[]; locations: Loc[]; orgs: Org[] }) {
  const t = useT("booking");
  const id = useId();
  const { busy, run, feedback, invalid } = useAction();
  const [mode, setMode] = useState<"in_clinic" | "video">(locations.length ? "in_clinic" : "video");
  const [payment, setPayment] = useState<"free" | "at_clinic" | "online">("at_clinic");

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const ok = await run("/api/provider/services", "POST", {
      name: String(f.get("name") ?? ""),
      mode,
      duration_min: Number(f.get("duration_min")),
      fee_inr: payment === "free" ? 0 : Number(f.get("fee_inr") || 0),
      payment_mode: payment,
      buffer_min: Number(f.get("buffer_min") || 0),
      intake_kind: String(f.get("intake_kind") ?? "none"),
      ...(mode === "in_clinic" ? { location_id: String(f.get("location_id") ?? "") } : orgs.length > 1 ? { org_id: String(f.get("org_id") ?? "") } : {}),
    });
    if (ok) e.currentTarget?.reset();
  }

  const bad = (field: string) => invalid.includes(field) || undefined;

  return (
    <div className="space-y-4">
      {services.length ? (
        <ul className="space-y-2">
          {services.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-slate-200 bg-white p-3 text-sm">
              <span className={s.active ? "text-slate-900" : "text-slate-500"}>
                <span className="font-medium">{s.name}</span> · {t("duration", { minutes: s.duration_min })} · {t(`modes.${s.mode}`)}
                {s.location_name ? ` (${s.location_name})` : ""} · {s.payment_mode === "free" ? t("payment.free") : `₹${s.fee_inr} · ${t(`payment.${s.payment_mode}`)}`}
                {s.active ? "" : ` · ${t("schedule.services.inactive")}`}
              </span>
              <button type="button" className={secondaryButtonClass} disabled={busy} onClick={() => run(`/api/provider/services/${s.id}`, "PATCH", { active: !s.active })}>
                {s.active ? t("schedule.services.turnOff") : t("schedule.services.turnOn")}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-slate-600">{t("schedule.services.none")}</p>
      )}
      <form onSubmit={submit} className="grid gap-3 rounded border border-slate-200 bg-slate-50 p-3 sm:grid-cols-2" aria-label={t("schedule.services.add")}>
        <div className="sm:col-span-2">
          <label htmlFor={`${id}-name`} className={labelClass}>{t("schedule.services.name")}</label>
          <input id={`${id}-name`} name="name" required maxLength={80} className={inputClass} aria-invalid={bad("name")} />
        </div>
        <div>
          <label htmlFor={`${id}-mode`} className={labelClass}>{t("schedule.services.mode")}</label>
          <select id={`${id}-mode`} value={mode} onChange={(e) => setMode(e.target.value as "in_clinic" | "video")} className={selectClass}>
            <option value="in_clinic" disabled={!locations.length}>{t("modes.in_clinic")}</option>
            <option value="video">{t("modes.video")}</option>
          </select>
        </div>
        {mode === "in_clinic" ? (
          <div>
            <label htmlFor={`${id}-loc`} className={labelClass}>{t("schedule.location")}</label>
            <select id={`${id}-loc`} name="location_id" className={selectClass} aria-invalid={bad("location_id")}>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </div>
        ) : orgs.length > 1 ? (
          <div>
            <label htmlFor={`${id}-org`} className={labelClass}>{t("schedule.organisation")}</label>
            <select id={`${id}-org`} name="org_id" className={selectClass}>
              {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </div>
        ) : <div />}
        <div>
          <label htmlFor={`${id}-dur`} className={labelClass}>{t("schedule.services.duration")}</label>
          <select id={`${id}-dur`} name="duration_min" defaultValue="30" className={selectClass}>
            {[15, 20, 30, 45, 60, 90].map((d) => <option key={d} value={d}>{t("duration", { minutes: d })}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor={`${id}-pay`} className={labelClass}>{t("schedule.services.payment")}</label>
          <select id={`${id}-pay`} value={payment} onChange={(e) => setPayment(e.target.value as "free" | "at_clinic" | "online")} className={selectClass}>
            <option value="at_clinic">{t("payment.at_clinic")}</option>
            <option value="online">{t("payment.online")}</option>
            <option value="free">{t("payment.free")}</option>
          </select>
        </div>
        {payment !== "free" ? (
          <div>
            <label htmlFor={`${id}-fee`} className={labelClass}>{t("schedule.services.fee")}</label>
            <input id={`${id}-fee`} name="fee_inr" type="number" inputMode="numeric" min={0} max={100000} defaultValue={500} className={inputClass} aria-invalid={bad("fee_inr")} />
          </div>
        ) : null}
        <div>
          <label htmlFor={`${id}-buf`} className={labelClass}>{t("schedule.services.buffer")}</label>
          <input id={`${id}-buf`} name="buffer_min" type="number" inputMode="numeric" min={0} max={30} defaultValue={0} className={inputClass} aria-invalid={bad("buffer_min")} />
        </div>
        <div>
          <label htmlFor={`${id}-intake`} className={labelClass}>{t("schedule.services.intake")}</label>
          <select id={`${id}-intake`} name="intake_kind" defaultValue="none" className={selectClass}>
            {(["none", "child_dev", "generic"] as const).map((k) => <option key={k} value={k}>{t(`schedule.services.intakeKinds.${k}`)}</option>)}
          </select>
        </div>
        <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
          <button type="submit" className={buttonClass} disabled={busy}>{t("schedule.services.add")}</button>
          {feedback}
        </div>
      </form>
    </div>
  );
}

export type RuleItem = { id: string; weekday: number; start_time: string; end_time: string; mode: "in_clinic" | "video" | "both"; location_name: string | null };

const WEEKDAY_KEYS = ["0", "1", "2", "3", "4", "5", "6"] as const;

export function HoursEditor({ rules, locations }: { rules: RuleItem[]; locations: Loc[] }) {
  const t = useT("booking");
  const id = useId();
  const { busy, run, feedback, invalid } = useAction();
  const [mode, setMode] = useState<"in_clinic" | "video" | "both">(locations.length ? "in_clinic" : "video");

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await run("/api/provider/availability/rules", "POST", {
      weekday: Number(f.get("weekday")),
      start_time: String(f.get("start_time")),
      end_time: String(f.get("end_time")),
      mode,
      ...(mode !== "video" ? { location_id: String(f.get("location_id") ?? "") } : {}),
    });
  }
  const bad = (field: string) => invalid.includes(field) || undefined;

  return (
    <div className="space-y-4">
      {rules.length ? (
        <ul className="space-y-2">
          {rules.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-slate-200 bg-white p-3 text-sm text-slate-900">
              <span>
                <span className="font-medium">{t(`schedule.weekdays.${WEEKDAY_KEYS[r.weekday]}`)}</span> {r.start_time}-{r.end_time} · {t(`schedule.modes.${r.mode}`)}
                {r.location_name ? ` · ${r.location_name}` : ""}
              </span>
              <button type="button" className={secondaryButtonClass} disabled={busy} onClick={() => run(`/api/provider/availability/rules/${r.id}`, "DELETE")}>
                {t("schedule.remove")}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-slate-600">{t("schedule.hours.none")}</p>
      )}
      <form onSubmit={submit} className="grid gap-3 rounded border border-slate-200 bg-slate-50 p-3 sm:grid-cols-3" aria-label={t("schedule.hours.add")}>
        <div>
          <label htmlFor={`${id}-day`} className={labelClass}>{t("schedule.hours.weekday")}</label>
          <select id={`${id}-day`} name="weekday" className={selectClass}>
            {WEEKDAY_KEYS.map((k) => <option key={k} value={k}>{t(`schedule.weekdays.${k}`)}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor={`${id}-from`} className={labelClass}>{t("schedule.hours.from")}</label>
          <input id={`${id}-from`} name="start_time" type="time" required defaultValue="10:00" step={300} className={inputClass} aria-invalid={bad("start_time")} />
        </div>
        <div>
          <label htmlFor={`${id}-to`} className={labelClass}>{t("schedule.hours.to")}</label>
          <input id={`${id}-to`} name="end_time" type="time" required defaultValue="13:00" step={300} className={inputClass} aria-invalid={bad("end_time")} />
        </div>
        <div>
          <label htmlFor={`${id}-mode`} className={labelClass}>{t("schedule.hours.mode")}</label>
          <select id={`${id}-mode`} value={mode} onChange={(e) => setMode(e.target.value as "in_clinic" | "video" | "both")} className={selectClass}>
            <option value="in_clinic" disabled={!locations.length}>{t("schedule.modes.in_clinic")}</option>
            <option value="video">{t("schedule.modes.video")}</option>
            <option value="both" disabled={!locations.length}>{t("schedule.modes.both")}</option>
          </select>
        </div>
        {mode !== "video" ? (
          <div className="sm:col-span-2">
            <label htmlFor={`${id}-loc`} className={labelClass}>{t("schedule.location")}</label>
            <select id={`${id}-loc`} name="location_id" className={selectClass} aria-invalid={bad("location_id")}>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-3 sm:col-span-3">
          <button type="submit" className={buttonClass} disabled={busy}>{t("schedule.hours.add")}</button>
          {feedback}
        </div>
      </form>
    </div>
  );
}

export type OverrideItem = {
  id: string;
  date: string;
  kind: "unavailable" | "extra";
  start_time: string | null;
  end_time: string | null;
  mode: "in_clinic" | "video" | "both" | null;
  location_name: string | null;
  note: string | null;
};

export function OverridesEditor({ overrides, locations, today }: { overrides: OverrideItem[]; locations: Loc[]; today: string }) {
  const t = useT("booking");
  const id = useId();
  const { busy, run, feedback, invalid } = useAction();
  const [kind, setKind] = useState<"unavailable" | "extra">("unavailable");
  const [wholeDay, setWholeDay] = useState(true);
  const [mode, setMode] = useState<"in_clinic" | "video" | "both">(locations.length ? "in_clinic" : "video");

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const timed = kind === "extra" || !wholeDay;
    await run("/api/provider/availability/overrides", "POST", {
      date: String(f.get("date")),
      kind,
      ...(timed ? { start_time: String(f.get("start_time")), end_time: String(f.get("end_time")) } : {}),
      ...(kind === "extra" ? { mode, ...(mode !== "video" ? { location_id: String(f.get("location_id") ?? "") } : {}) } : {}),
      ...(f.get("note") ? { note: String(f.get("note")) } : {}),
    });
  }
  const bad = (field: string) => invalid.includes(field) || undefined;

  return (
    <div className="space-y-4">
      {overrides.length ? (
        <ul className="space-y-2">
          {overrides.map((o) => (
            <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-slate-200 bg-white p-3 text-sm text-slate-900">
              <span>
                <span className="font-medium">{o.date}</span> · {o.kind === "unavailable" ? t("schedule.overrides.blocked") : t("schedule.overrides.extraHours")}
                {o.start_time ? ` ${o.start_time}-${o.end_time}` : ` · ${t("schedule.overrides.wholeDay")}`}
                {o.mode ? ` · ${t(`schedule.modes.${o.mode}`)}` : ""}
                {o.location_name ? ` · ${o.location_name}` : ""}
                {o.note ? <span className="block text-slate-600">{o.note}</span> : null}
              </span>
              <button type="button" className={secondaryButtonClass} disabled={busy} onClick={() => run(`/api/provider/availability/overrides/${o.id}`, "DELETE")}>
                {t("schedule.remove")}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-slate-600">{t("schedule.overrides.none")}</p>
      )}
      <div className="flex flex-wrap gap-2" role="group">
        <button type="button" aria-pressed={kind === "unavailable"} className={kind === "unavailable" ? buttonClass : secondaryButtonClass} onClick={() => setKind("unavailable")}>
          {t("schedule.overrides.block")}
        </button>
        <button type="button" aria-pressed={kind === "extra"} className={kind === "extra" ? buttonClass : secondaryButtonClass} onClick={() => setKind("extra")}>
          {t("schedule.overrides.extra")}
        </button>
      </div>
      <form onSubmit={submit} className="grid gap-3 rounded border border-slate-200 bg-slate-50 p-3 sm:grid-cols-3" aria-label={kind === "unavailable" ? t("schedule.overrides.block") : t("schedule.overrides.extra")}>
        <div>
          <label htmlFor={`${id}-date`} className={labelClass}>{t("schedule.overrides.date")}</label>
          <input id={`${id}-date`} name="date" type="date" required min={today} defaultValue={today} className={inputClass} aria-invalid={bad("date")} />
        </div>
        {kind === "unavailable" ? (
          <label className="flex min-h-11 items-center gap-2 self-end text-sm text-slate-900">
            <input type="checkbox" className="h-5 w-5" checked={wholeDay} onChange={(e) => setWholeDay(e.target.checked)} />
            {t("schedule.overrides.wholeDay")}
          </label>
        ) : null}
        {kind === "extra" || !wholeDay ? (
          <>
            <div>
              <label htmlFor={`${id}-from`} className={labelClass}>{t("schedule.hours.from")}</label>
              <input id={`${id}-from`} name="start_time" type="time" required defaultValue="16:00" step={300} className={inputClass} aria-invalid={bad("start_time")} />
            </div>
            <div>
              <label htmlFor={`${id}-to`} className={labelClass}>{t("schedule.hours.to")}</label>
              <input id={`${id}-to`} name="end_time" type="time" required defaultValue="18:00" step={300} className={inputClass} aria-invalid={bad("end_time")} />
            </div>
          </>
        ) : null}
        {kind === "extra" ? (
          <>
            <div>
              <label htmlFor={`${id}-mode`} className={labelClass}>{t("schedule.hours.mode")}</label>
              <select id={`${id}-mode`} value={mode} onChange={(e) => setMode(e.target.value as "in_clinic" | "video" | "both")} className={selectClass}>
                <option value="in_clinic" disabled={!locations.length}>{t("schedule.modes.in_clinic")}</option>
                <option value="video">{t("schedule.modes.video")}</option>
                <option value="both" disabled={!locations.length}>{t("schedule.modes.both")}</option>
              </select>
            </div>
            {mode !== "video" ? (
              <div className="sm:col-span-2">
                <label htmlFor={`${id}-loc`} className={labelClass}>{t("schedule.location")}</label>
                <select id={`${id}-loc`} name="location_id" className={selectClass} aria-invalid={bad("location_id")}>
                  {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
              </div>
            ) : null}
          </>
        ) : null}
        <div className="sm:col-span-3">
          <label htmlFor={`${id}-note`} className={labelClass}>{t("schedule.overrides.note")}</label>
          <input id={`${id}-note`} name="note" maxLength={200} className={inputClass} />
        </div>
        <div className="flex flex-wrap items-center gap-3 sm:col-span-3">
          <button type="submit" className={buttonClass} disabled={busy}>
            {kind === "unavailable" ? t("schedule.overrides.block") : t("schedule.overrides.extra")}
          </button>
          {feedback}
        </div>
      </form>
    </div>
  );
}
