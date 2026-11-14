"use client";

// 044 FR-3/FR-4/FR-5: the daily register rows. One tap marks a session (Present / Absent / Late cancel / Centre
// cancelled); tapping another outcome on a marked session asks for a reason (correction, audited); cancelling a session
// that has not started asks first (the family is told). Counts update from the server's answers. Works at 375 px:
// the four buttons sit in a 2 x 2 grid of 44 px targets.
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { send } from "@/components/providers/request";
import {
  ATTENDANCE_VALUES,
  attendanceCounts,
  canMarkNow,
  effectiveAttendance,
  remainingToMark,
  withinMemberWindow,
  type Attendance,
} from "@/lib/booking/attendance-display";
import { hasStarted } from "@/lib/booking/display";
import { useFormatter, useT } from "@/lib/i18n/client";
import { Button } from "@/components/ui/Button";

export type RegisterClientRow = {
  id: string;
  starts_at: string;
  ends_at: string;
  status: string;
  attendance: Attendance | null;
  billable: boolean | null;
  child_name: string | null;
  case_id: string | null;
  provider_profile_id: string;
  provider_name: string;
  service_name: string;
  mode: "in_clinic" | "video";
  series_id: string | null;
};

type Pending = { id: string; value: Attendance; kind: "correction" | "cancel" };
type ErrorCode = "not_started" | "reason_required" | "correction_window" | "invalid_transition" | "not_found" | "generic";
const KNOWN_ERRORS: ErrorCode[] = ["not_started", "reason_required", "correction_window", "invalid_transition", "not_found"];

const VALUE_STYLE: Record<Attendance, string> = {
  present: "border-emerald-700 bg-emerald-700 text-white",
  absent: "border-red-700 bg-red-700 text-white",
  late_cancel_family: "border-amber-600 bg-amber-100 text-amber-950",
  cancelled_centre: "border-slate-700 bg-slate-700 text-white",
};

const btn = "inline-flex min-h-11 items-center justify-center rounded border px-2 py-2 text-sm font-medium disabled:opacity-50";
const idle = "border-slate-300 bg-white text-slate-900 hover:bg-slate-50";

export function RegisterClient({
  rows: initialRows,
  manage,
  now: nowIso,
}: {
  rows: RegisterClientRow[];
  /** Owner/admin of the organisation: no 7-day limit. */
  manage: boolean;
  /** Server render time, so the first paint matches the server's start-time checks. */
  now: string;
}) {
  const t = useT("attendance");
  const format = useFormatter();
  const [rows, setRows] = useState(initialRows);
  const [busy, setBusy] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<Record<string, ErrorCode>>({});
  const [bulkMessage, setBulkMessage] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.parse(nowIso));

  // Sessions become markable at their start time while the page stays open.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const counts = attendanceCounts(rows);
  const groups = useMemo(() => {
    const map = new Map<string, { name: string; rows: RegisterClientRow[] }>();
    for (const r of rows) {
      const g = map.get(r.provider_profile_id) ?? { name: r.provider_name, rows: [] };
      g.rows.push(r);
      map.set(r.provider_profile_id, g);
    }
    return [...map.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name));
  }, [rows]);

  function apply(id: string, patch: Partial<RegisterClientRow>) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  async function submit(row: RegisterClientRow, value: Attendance, why?: string) {
    setBusy(row.id);
    setErrors((e) => {
      const next = { ...e };
      delete next[row.id];
      return next;
    });
    const res = await send(`/api/appointments/${row.id}/attendance`, "POST", why ? { attendance: value, reason: why } : { attendance: value });
    setBusy(null);
    if (res.ok) {
      apply(row.id, {
        attendance: res.json.attendance as Attendance,
        status: String(res.json.status),
        billable: (res.json.billable as boolean | null) ?? null,
      });
      setPending(null);
      setReason("");
      return;
    }
    const code = KNOWN_ERRORS.includes(res.json.code as ErrorCode) ? (res.json.code as ErrorCode) : "generic";
    setErrors((e) => ({ ...e, [row.id]: code }));
  }

  function tap(row: RegisterClientRow, value: Attendance) {
    const current = effectiveAttendance(row);
    if (current === value) return;
    if (current) {
      setPending({ id: row.id, value, kind: "correction" });
      setReason("");
      return;
    }
    if ((value === "late_cancel_family" || value === "cancelled_centre") && !hasStarted(row.starts_at)) {
      setPending({ id: row.id, value, kind: "cancel" });
      return;
    }
    void submit(row, value);
  }

  async function markAll() {
    const ids = remainingToMark(rows).map((r) => r.id);
    setBulkMessage(null);
    if (ids.length === 0) {
      setBulkMessage(t("register.markAllNone"));
      return;
    }
    setBusy("all");
    const res = await send("/api/attendance/mark-all", "POST", { appointment_ids: ids });
    setBusy(null);
    if (!res.ok) {
      setBulkMessage(t("register.errors.generic"));
      return;
    }
    const marked = (res.json.marked as { appointment_id: string; billable: boolean | null }[]) ?? [];
    setRows((prev) =>
      prev.map((r) => {
        const m = marked.find((x) => x.appointment_id === r.id);
        return m ? { ...r, attendance: "present", status: "completed", billable: m.billable } : r;
      }),
    );
    setBulkMessage(t("register.markAllDone", { count: marked.length }));
  }

  if (rows.length === 0) return <p className="text-slate-600">{t("register.none")}</p>;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 rounded border border-slate-200 bg-slate-50 p-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm font-medium text-slate-900" data-testid="register-counts" aria-live="polite">
          {t("register.counts", {
            present: counts.present,
            absent: counts.absent,
            cancelled: counts.late_cancel_family + counts.cancelled_centre,
            unmarked: counts.unmarked,
          })}
        </p>
        <Button
          type="button"
          onClick={markAll}
          disabled={busy !== null}
        >
          {t("register.markAll")}
        </Button>
      </div>
      {bulkMessage ? (
        <p role="status" className="text-sm text-slate-800">
          {bulkMessage}
        </p>
      ) : null}

      {groups.map(([profileId, group]) => (
        <section key={profileId} aria-labelledby={`therapist-${profileId}`} className="space-y-2">
          <h2 id={`therapist-${profileId}`} className="text-lg font-semibold text-slate-900">
            {group.name}
          </h2>
          <ul className="space-y-2">
            {group.rows.map((row) => {
              const current = effectiveAttendance(row);
              const locked = !manage && !withinMemberWindow(row.starts_at, now);
              const started = Date.parse(row.starts_at) <= now;
              const asking = pending?.id === row.id ? pending : null;
              const error = errors[row.id];
              return (
                <li key={row.id} className="space-y-2 rounded border border-slate-200 bg-white p-3 text-sm" data-testid="register-row" data-attendance={current ?? ""}>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-semibold text-slate-900">
                        {format.time(row.starts_at)} - {format.time(row.ends_at)}
                      </p>
                      <p className="break-words text-slate-800">
                        {row.child_name ?? t("register.noChild")} · {row.service_name}
                        {row.mode === "video" ? ` · ${t("register.video")}` : ""}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-1">
                      {row.series_id ? (
                        <span className="rounded-full bg-indigo-50 px-3 py-1 text-xs font-semibold text-indigo-900">{t("register.weekly")}</span>
                      ) : null}
                      {current ? (
                        <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-800" data-testid="marked-label">
                          {t("register.marked", { value: t(`values.${current}`) })}
                          {row.billable !== null ? ` · ${row.billable ? t("register.billable") : t("register.notBillable")}` : ""}
                        </span>
                      ) : null}
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="group" aria-label={t("register.title")}>
                    {ATTENDANCE_VALUES.map((value) => {
                      const selected = current === value;
                      const allowed = !locked && canMarkNow(value, row.starts_at, now);
                      return (
                        <button
                          key={value}
                          type="button"
                          aria-pressed={selected}
                          disabled={busy !== null || !allowed}
                          onClick={() => tap(row, value)}
                          className={`${btn} ${selected ? VALUE_STYLE[value] : idle}`}
                        >
                          {t(`values.${value}`)}
                        </button>
                      );
                    })}
                  </div>

                  {!started && !current ? <p className="text-xs text-slate-600">{t("register.notStarted", { time: format.time(row.starts_at) })}</p> : null}
                  {locked ? <p className="text-xs text-slate-600">{t("register.outsideWindow")}</p> : null}

                  {current === "present" && row.case_id ? (
                    <Link
                      href={row.mode === "in_clinic" ? `/cases/${row.case_id}/sessions/new?appointment=${row.id}` : `/cases/${row.case_id}`}
                      className="inline-flex min-h-11 items-center font-semibold text-teal-800 underline"
                      data-testid="write-note"
                    >
                      {row.mode === "in_clinic" ? t("register.writeNote") : t("register.openCase")}
                    </Link>
                  ) : null}

                  {asking?.kind === "correction" ? (
                    <form
                      className="space-y-2 rounded border border-amber-200 bg-amber-50 p-3"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void submit(row, asking.value, reason.trim());
                      }}
                    >
                      <p className="font-medium text-slate-900">{t("register.correctTitle", { value: t(`values.${asking.value}`) })}</p>
                      <label htmlFor={`reason-${row.id}`} className="block text-sm font-medium text-slate-800">
                        {t("register.reasonLabel")}
                      </label>
                      <input
                        id={`reason-${row.id}`}
                        value={reason}
                        required
                        maxLength={300}
                        onChange={(e) => setReason(e.target.value)}
                        aria-describedby={`reason-hint-${row.id}`}
                        className="block min-h-11 w-full rounded border border-slate-300 bg-white px-3 py-2 text-base sm:text-sm"
                      />
                      <p id={`reason-hint-${row.id}`} className="text-xs text-slate-600">
                        {t("register.reasonHint")}
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <Button type="submit" disabled={busy !== null || reason.trim() === ""}>
                          {t("register.saveCorrection")}
                        </Button>
                        <button type="button" onClick={() => setPending(null)} className={`${btn} ${idle} px-4`}>
                          {t("register.keep")}
                        </button>
                      </div>
                    </form>
                  ) : null}

                  {asking?.kind === "cancel" ? (
                    <div className="flex flex-wrap items-center gap-2 rounded border border-red-200 bg-red-50 p-2" role="group">
                      <p className="w-full text-sm text-red-900">{t("register.cancelQuestion")}</p>
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() => void submit(row, asking.value)}
                        className="inline-flex min-h-11 items-center rounded bg-red-700 px-4 text-sm font-medium text-white disabled:opacity-50"
                      >
                        {t("register.yesCancel")}
                      </button>
                      <button type="button" onClick={() => setPending(null)} className={`${btn} ${idle} px-4`}>
                        {t("register.keep")}
                      </button>
                    </div>
                  ) : null}

                  {error ? (
                    <p role="alert" className="text-sm text-red-800">
                      {t(`register.errors.${error}`)}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
