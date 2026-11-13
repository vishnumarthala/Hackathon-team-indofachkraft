"use client";

import { useEffect, useMemo, useState } from "react";
import { dayLabel, slotTimeLabel, viewerDate } from "@/lib/booking/display";
import { useLocale, useT, useTimeZone } from "@/lib/i18n/client";

export type PickedSlot = { start: string; end: string };

type Props = {
  profileId: string;
  serviceId: string;
  /** In-clinic services: the clinic's time zone (shown next to the viewer's time when it differs). */
  clinicTimeZone: string | null;
  selected: PickedSlot | null;
  onSelect: (slot: PickedSlot) => void;
  /** Bump to refetch (e.g. after a 409). */
  refreshKey?: number;
  exclude?: string | null;
};

// FR-7: date strip + time buttons for the next 14 days, in the viewer's time zone (NFR-2). 375 px: the date strip
// scrolls horizontally, times wrap.
export function SlotPicker({ profileId, serviceId, clinicTimeZone, selected, onSelect, refreshKey = 0, exclude = null }: Props) {
  const t = useT("booking");
  const locale = useLocale();
  const viewerTz = useTimeZone();
  const requestKey = `${profileId}|${serviceId}|${refreshKey}|${exclude ?? ""}`;
  // Results are stored with the request they answer, so a new request shows "loading" without resetting state in
  // the effect body.
  const [result, setResult] = useState<{ key: string; slots: PickedSlot[] | null; failed: boolean } | null>(null);
  const [day, setDay] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/public/providers/${profileId}/slots?service_id=${serviceId}&days=14`, { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((body: { slots: PickedSlot[] }) => {
        if (!cancelled) setResult({ key: requestKey, slots: body.slots.filter((s) => s.start !== exclude), failed: false });
      })
      .catch(() => {
        if (!cancelled) setResult({ key: requestKey, slots: null, failed: true });
      });
    return () => {
      cancelled = true;
    };
  }, [profileId, serviceId, exclude, requestKey]);

  const current = result?.key === requestKey ? result : null;
  const slots = current?.slots ?? null;
  const failed = current?.failed ?? false;

  const byDay = useMemo(() => {
    const map = new Map<string, PickedSlot[]>();
    for (const s of slots ?? []) {
      const key = viewerDate(s.start, viewerTz);
      map.set(key, [...(map.get(key) ?? []), s]);
    }
    return map;
  }, [slots, viewerTz]);

  const days = [...byDay.keys()];
  const activeDay = day && byDay.has(day) ? day : (days[0] ?? null);

  if (failed) return <p role="alert" className="text-sm text-red-700">{t("errors.generic")}</p>;
  if (!slots) return <p role="status" className="text-sm text-slate-600">{t("flow.loading")}</p>;
  if (days.length === 0) return <p className="rounded border border-dashed border-slate-300 bg-white p-4 text-sm text-slate-700">{t("flow.noSlots")}</p>;

  return (
    <div className="space-y-4">
      {/* min-w-0: a fieldset is min-content wide by default, which would widen the page instead of scrolling the strip. */}
      <fieldset className="min-w-0">
        <legend className="mb-2 text-sm font-semibold text-slate-900">{t("flow.date")}</legend>
        <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-2" role="group">
          {days.map((d) => {
            const label = dayLabel(d, locale);
            const active = d === activeDay;
            return (
              <button
                key={d}
                type="button"
                aria-pressed={active}
                onClick={() => setDay(d)}
                className={`flex min-h-14 min-w-16 shrink-0 flex-col items-center justify-center rounded-lg border px-3 py-1 text-sm ${
                  active ? "border-teal-700 bg-teal-50 font-semibold text-teal-900" : "border-slate-300 bg-white text-slate-800"
                }`}
              >
                <span>{label.weekday}</span>
                <span>{label.day}</span>
              </button>
            );
          })}
        </div>
      </fieldset>
      <fieldset className="min-w-0">
        <legend className="mb-2 text-sm font-semibold text-slate-900">{t("flow.time")}</legend>
        <div className="flex flex-wrap gap-2">
          {(activeDay ? (byDay.get(activeDay) ?? []) : []).map((s) => {
            const active = selected?.start === s.start;
            return (
              <button
                key={s.start}
                type="button"
                aria-pressed={active}
                onClick={() => onSelect(s)}
                className={`min-h-11 rounded-lg border px-3 py-2 text-sm ${
                  active ? "border-teal-700 bg-teal-700 font-semibold text-white" : "border-slate-300 bg-white text-slate-900 hover:bg-slate-50"
                }`}
              >
                {slotTimeLabel(s.start, locale, viewerTz, clinicTimeZone, (key, vars) => t(key, vars))}
              </button>
            );
          })}
        </div>
      </fieldset>
      <p className="text-xs text-slate-600">{t("flow.timeZoneNote", { zone: viewerTz })}</p>
    </div>
  );
}
