"use client";

// Ticket 026 FR-5 / NFR-1: `Done today` on the guardian's phone. One tap opens the sheet, one choice (`Hard`,
// `Okay`, `Easy`), `Save`; minutes and note are optional. The request is retried with the same activity + date and,
// when offline, kept on the phone until the browser is online again (`PendingLogsSync`). Also lists the guardian's
// own entries of this week with `Remove`.
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { DIFFICULTIES, type Difficulty } from "@/lib/home-program/schema";
import { useFormatter, useT } from "@/lib/i18n/client";
import { flushQueue, submitLog, type KeyValueStorage } from "./logQueue";
import { DIFFICULTY_STYLES, sendJson, type HomeProgramErrorKey } from "./view";

const primary = "min-h-12 w-full rounded-xl bg-teal-800 px-4 py-3 text-base font-semibold text-white disabled:opacity-50 sm:w-auto";
const secondary = "min-h-11 rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-900 disabled:opacity-50";
const inputClass = "mt-1 block w-full rounded-xl border border-slate-300 px-3 py-2 text-base";

export type OwnLog = { id: string; done_on: string; difficulty: Difficulty; duration_min: number | null; note: string | null };

const browserStorage = (): KeyValueStorage | null => {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
};
const browserFetch: typeof fetch = (input, init) => fetch(input, init);

/** Sends logs saved on this phone while offline, now and whenever the browser comes back online. */
export function PendingLogsSync() {
  const router = useRouter();
  useEffect(() => {
    let cancelled = false;
    const flush = async () => {
      const sent = await flushQueue(browserFetch, browserStorage());
      if (sent > 0 && !cancelled) router.refresh();
    };
    void flush();
    window.addEventListener("online", flush);
    return () => {
      cancelled = true;
      window.removeEventListener("online", flush);
    };
  }, [router]);
  return null;
}

export function DoneToday({
  activityId,
  activityTitle,
  today,
  ownLogs,
}: {
  activityId: string;
  activityTitle: string;
  today: string;
  ownLogs: OwnLog[];
}) {
  const t = useT("homeProgram.family");
  const td = useT("homeProgram.difficulty");
  const te = useT("homeProgram.errors");
  const format = useFormatter();
  const router = useRouter();
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [difficulty, setDifficulty] = useState<Difficulty | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<HomeProgramErrorKey | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const todays = ownLogs.find((l) => l.done_on === today) ?? null;

  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    if (open && !el.open) {
      if (typeof el.showModal === "function") el.showModal();
      else el.setAttribute("open", "");
    } else if (!open && el.open) {
      if (typeof el.close === "function") el.close();
      else el.removeAttribute("open");
    }
  }, [open]);

  function start() {
    setError(null);
    setStatus(null);
    setDifficulty(todays?.difficulty ?? null);
    setOpen(true);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!difficulty) return;
    const data = new FormData(event.currentTarget);
    const rawMinutes = String(data.get("duration_min") ?? "").trim();
    const note = String(data.get("note") ?? "").trim();
    setBusy(true);
    setError(null);
    const result = await submitLog(
      browserFetch,
      {
        activityId,
        body: { done_on: today, difficulty, duration_min: rawMinutes ? Number(rawMinutes) : null, note: note || null },
      },
      { storage: browserStorage() },
    );
    setBusy(false);
    if (result.ok) {
      setOpen(false);
      setStatus(t("saved"));
      router.refresh();
    } else if ("queued" in result) {
      setOpen(false);
      setStatus(t("savedOffline"));
    } else {
      setError(result.error);
    }
  }

  async function remove(log: OwnLog) {
    setStatus(null);
    setError(null);
    const result = await sendJson(browserFetch, `/api/family/home-activity-logs/${log.id}`, "DELETE");
    if (result.ok) {
      setStatus(t("removed"));
      router.refresh();
    } else setError(result.error);
  }

  const day = (d: string) => format.date(`${d}T12:00:00Z`, "short");

  return (
    <div className="space-y-3">
      <button type="button" className={primary} onClick={start} aria-label={t("doneLabel", { activity: activityTitle })} data-done-today={activityId}>
        {todays ? t("doneAgain") : t("doneToday")}
      </button>
      {status ? (
        <p role="status" className="text-sm font-medium text-emerald-800">
          {status}
        </p>
      ) : null}
      {error && !open ? (
        <p role="alert" className="text-sm font-medium text-red-700">
          {te(error)}
        </p>
      ) : null}
      {ownLogs.length > 0 ? (
        <div>
          <h4 className="text-sm font-semibold text-slate-900">{t("yourEntries")}</h4>
          <ul className="mt-1 space-y-1">
            {ownLogs.map((log) => (
              <li key={log.id} className="flex flex-wrap items-center gap-2 text-sm text-slate-800" data-own-log={log.id}>
                <span>
                  {day(log.done_on)}: {td(log.difficulty)}
                </span>
                <button type="button" className={secondary} onClick={() => remove(log)} aria-label={t("removeLabel", { date: day(log.done_on) })}>
                  {t("remove")}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <dialog
        ref={dialog}
        aria-labelledby={`${id}-title`}
        onClose={() => setOpen(false)}
        className="m-auto w-[calc(100%-1rem)] max-w-md rounded-2xl p-0 backdrop:bg-slate-900/50"
      >
        <form onSubmit={save} className="space-y-4 p-4 sm:p-6" noValidate>
          <div>
            <h3 id={`${id}-title`} className="text-lg font-semibold text-slate-900">
              {t("sheetTitle")}
            </h3>
            <p className="text-sm break-words text-slate-700">{activityTitle}</p>
          </div>
          {error ? (
            <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
              {te(error)}
            </p>
          ) : null}
          <fieldset>
            <legend className="sr-only">{t("sheetTitle")}</legend>
            <div className="grid grid-cols-3 gap-2">
              {DIFFICULTIES.map((d) => (
                <label
                  key={d}
                  className={`flex min-h-14 cursor-pointer items-center justify-center rounded-xl border-2 px-2 text-base font-semibold ${
                    difficulty === d ? `${DIFFICULTY_STYLES[d]} ring-2 ring-teal-800` : "border-slate-200 bg-white text-slate-900"
                  }`}
                >
                  <input
                    type="radio"
                    name="difficulty"
                    value={d}
                    checked={difficulty === d}
                    onChange={() => setDifficulty(d)}
                    className="sr-only"
                  />
                  {td(d)}
                </label>
              ))}
            </div>
          </fieldset>
          <div>
            <label htmlFor={`${id}-minutes`} className="block text-sm font-semibold text-slate-900">
              {t("minutes")} <span className="font-normal text-slate-600">{t("optional")}</span>
            </label>
            <input
              id={`${id}-minutes`}
              name="duration_min"
              type="number"
              inputMode="numeric"
              min={1}
              max={240}
              step={1}
              defaultValue={todays?.duration_min ?? ""}
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor={`${id}-note`} className="block text-sm font-semibold text-slate-900">
              {t("note")} <span className="font-normal text-slate-600">{t("optional")}</span>
            </label>
            <textarea id={`${id}-note`} name="note" maxLength={500} rows={2} defaultValue={todays?.note ?? ""} className={inputClass} />
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="submit" className={primary} disabled={busy || !difficulty}>
              {busy ? t("saving") : t("save")}
            </button>
            <button type="button" className={secondary} onClick={() => setOpen(false)}>
              {t("cancel")}
            </button>
          </div>
        </form>
      </dialog>
    </div>
  );
}
