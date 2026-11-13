"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useT } from "@/lib/i18n/client";
import { secondaryButtonClass, send } from "@/components/providers/request";

type ErrorKey = "too_late" | "invalid_transition" | "generic";

/** FR-7 `Cancel` with an inline confirmation (guardian list) - also used by the provider agenda with `side="provider"`. */
export function CancelAppointmentButton({ appointmentId, side = "guardian" }: { appointmentId: string; side?: "guardian" | "provider" }) {
  const t = useT("booking");
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorKey | null>(null);

  async function cancel() {
    setBusy(true);
    setError(null);
    const res = await send(`/api/appointments/${appointmentId}/cancel`, "POST", {});
    setBusy(false);
    if (res.ok) {
      setAsking(false);
      router.refresh();
      return;
    }
    const code = res.json.code;
    setError(code === "too_late" || code === "invalid_transition" ? code : "generic");
  }

  if (!asking) {
    return (
      <button type="button" className={secondaryButtonClass} onClick={() => setAsking(true)}>
        {side === "provider" ? t("schedule.agenda.cancel") : t("list.cancel")}
      </button>
    );
  }
  return (
    <div className="flex w-full flex-wrap items-center gap-2 rounded border border-red-200 bg-red-50 p-2" role="group">
      <p className="text-sm text-red-900">{side === "provider" ? t("schedule.agenda.cancelQuestion") : t("list.cancelQuestion")}</p>
      <button type="button" disabled={busy} onClick={cancel} className="inline-flex min-h-11 items-center rounded bg-red-700 px-4 text-sm font-medium text-white disabled:opacity-50">
        {t("list.yesCancel")}
      </button>
      <button type="button" disabled={busy} onClick={() => setAsking(false)} className={secondaryButtonClass}>
        {t("list.keep")}
      </button>
      {error ? <p role="alert" className="w-full text-sm text-red-800">{t(`errors.${error}`)}</p> : null}
    </div>
  );
}

/** Provider agenda: `Mark completed` / `No-show` (409 before the start). */
export function CompleteButtons({ appointmentId, started }: { appointmentId: string; started: boolean }) {
  const t = useT("booking");
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function mark(status: "completed" | "no_show") {
    setBusy(true);
    setError(null);
    const res = await send(`/api/appointments/${appointmentId}/complete`, "POST", { status });
    setBusy(false);
    if (res.ok) return router.refresh();
    setError(res.json.code === "not_started" ? t("schedule.agenda.notStarted") : t("errors.generic"));
  }

  return (
    <>
      <button type="button" className={secondaryButtonClass} disabled={busy} aria-describedby={started ? undefined : `not-started-${appointmentId}`} onClick={() => mark("completed")}>
        {t("schedule.agenda.markCompleted")}
      </button>
      <button type="button" className={secondaryButtonClass} disabled={busy} onClick={() => mark("no_show")}>
        {t("schedule.agenda.noShow")}
      </button>
      {!started ? (
        <p id={`not-started-${appointmentId}`} className="w-full text-xs text-slate-600">
          {t("schedule.agenda.notStarted")}
        </p>
      ) : null}
      {error ? <p role="alert" className="w-full text-sm text-red-800">{error}</p> : null}
    </>
  );
}
