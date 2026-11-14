"use client";

// Ticket 052 FR-4 / E-4: one-tap attendance from the dashboard's Today panel (044's POST /api/appointments/:id/attendance,
// which re-checks the actor) and `Write note` (038) once a session is marked present. Corrections and cancellations
// stay on the register (they need a reason or a confirmation).
import Link from "next/link";
import { useEffect, useState } from "react";
import { send } from "@/components/providers/request";
import { effectiveAttendance, type Attendance } from "@/lib/booking/attendance-display";
import { useFormatter, useT } from "@/lib/i18n/client";

type Props = {
  id: string;
  startsAt: string;
  status: string;
  attendance: Attendance | null;
  caseId: string | null;
  mode: "in_clinic" | "video";
  hasNote: boolean;
  registerHref: string;
  /** Server render time, so the first paint matches the server's start-time check. */
  now: string;
};

const btn =
  "inline-flex min-h-11 min-w-24 items-center justify-center rounded-lg border px-3 py-2 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 disabled:opacity-50";

export function TodaySessionActions(props: Props) {
  const t = useT("dashboard.today");
  const ta = useT("attendance");
  const format = useFormatter();
  const [value, setValue] = useState<Attendance | null>(effectiveAttendance(props));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [now, setNow] = useState(() => Date.parse(props.now));

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const started = Date.parse(props.startsAt) <= now;

  async function mark(next: Attendance) {
    setBusy(true);
    setError(false);
    const res = await send(`/api/appointments/${props.id}/attendance`, "POST", { attendance: next });
    setBusy(false);
    if (res.ok) setValue((res.json.attendance as Attendance) ?? next);
    else setError(true);
  }

  if (value) {
    const note =
      value === "present" && props.caseId && !props.hasNote
        ? props.mode === "in_clinic"
          ? { href: `/cases/${props.caseId}/sessions/new?appointment=${props.id}`, label: t("writeNote") }
          : { href: `/cases/${props.caseId}`, label: t("openCase") }
        : null;
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-800" data-testid="today-marked" role="status">
          {t("marked", { value: ta(`values.${value}`) })}
        </span>
        {note ? (
          <Link href={note.href} className="inline-flex min-h-11 items-center font-semibold text-teal-800 underline" data-testid="today-write-note">
            {note.label}
          </Link>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap gap-2" role="group" aria-label={t("markLabel")}>
        <button
          type="button"
          disabled={busy || !started}
          onClick={() => void mark("present")}
          className={`${btn} border-teal-700 bg-teal-700 text-white hover:bg-teal-800`}
          data-testid="today-present"
        >
          {ta("values.present")}
        </button>
        <button type="button" disabled={busy || !started} onClick={() => void mark("absent")} className={`${btn} border-slate-300 bg-white text-slate-900 hover:bg-slate-50`}>
          {ta("values.absent")}
        </button>
      </div>
      {!started ? <p className="text-xs text-slate-600">{t("notStarted", { time: format.time(props.startsAt) })}</p> : null}
      {error ? (
        <p role="alert" className="text-sm text-red-800">
          {t("error")}{" "}
          <Link href={props.registerHref} className="font-semibold underline">
            {t("register")}
          </Link>
        </p>
      ) : null}
    </div>
  );
}
