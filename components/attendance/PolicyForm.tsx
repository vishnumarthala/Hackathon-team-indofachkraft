"use client";

// 044 FR-2 / D-2: the organisation's attendance billing rules (owner/admin). Defaults: absences and late family
// cancellations are not charged; a cancellation is late within 24 hours of the start.
import { useRouter } from "next/navigation";
import { useState } from "react";
import { buttonClass, send } from "@/components/providers/request";
import { useT } from "@/lib/i18n/client";

export type PolicyValue = { bill_absent: boolean; bill_late_cancel: boolean; late_cancel_hours: number };

export function PolicyForm({ orgId, policy }: { orgId: string; policy: PolicyValue }) {
  const t = useT("attendance.policy");
  const router = useRouter();
  const [value, setValue] = useState(policy);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    const res = await send(`/api/orgs/${orgId}/attendance-policy`, "PUT", value);
    setBusy(false);
    setMessage(res.ok ? { ok: true, text: t("saved") } : { ok: false, text: t("failed") });
    if (res.ok) router.refresh();
  }

  return (
    <form onSubmit={save} className="space-y-3">
      <label className="flex min-h-11 items-center gap-3 text-sm text-slate-900">
        <input
          type="checkbox"
          className="h-5 w-5"
          checked={value.bill_absent}
          onChange={(e) => setValue({ ...value, bill_absent: e.target.checked })}
        />
        {t("billAbsent")}
      </label>
      <label className="flex min-h-11 items-center gap-3 text-sm text-slate-900">
        <input
          type="checkbox"
          className="h-5 w-5"
          checked={value.bill_late_cancel}
          onChange={(e) => setValue({ ...value, bill_late_cancel: e.target.checked })}
        />
        {t("billLateCancel")}
      </label>
      <div>
        <label htmlFor={`late-hours-${orgId}`} className="block text-sm font-medium text-slate-800">
          {t("lateCancelHours")}
        </label>
        <input
          id={`late-hours-${orgId}`}
          type="number"
          inputMode="numeric"
          min={0}
          max={168}
          step={1}
          required
          value={value.late_cancel_hours}
          onChange={(e) => setValue({ ...value, late_cancel_hours: Math.max(0, Math.min(168, Math.trunc(Number(e.target.value) || 0))) })}
          className="mt-1 block min-h-11 w-32 rounded border border-slate-300 bg-white px-3 py-2 text-base sm:text-sm"
        />
      </div>
      <button type="submit" disabled={busy} className={buttonClass}>
        {t("save")}
      </button>
      {message ? (
        <p role="status" className={message.ok ? "text-sm text-emerald-800" : "text-sm text-red-700"}>
          {message.text}
        </p>
      ) : null}
    </form>
  );
}
