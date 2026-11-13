"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { feeLabel, slotTimeLabel } from "@/lib/booking/display";
import { useFormatter, useLocale, useT, useTimeZone } from "@/lib/i18n/client";
import { buttonClass, labelClass, secondaryButtonClass, send } from "@/components/providers/request";
import { SlotPicker, type PickedSlot } from "./SlotPicker";

export type FlowService = {
  id: string;
  name: string;
  mode: "in_clinic" | "video";
  duration_min: number;
  fee_inr: number;
  payment_mode: "online" | "at_clinic" | "free";
  location_name: string | null;
  location_address: string | null;
  time_zone: string;
};

export type FlowHold = { id: string; serviceId: string | null; start: string; end: string; expiresAt: string };
export type FlowChild = { id: string; name: string; age: string };

type Props = {
  profile: { id: string; name: string; slug: string };
  services: FlowService[];
  viewer: { signedIn: boolean; isGuardian: boolean; children: FlowChild[] };
  initialHold: FlowHold | null;
};

type ErrorCode = "slot_taken" | "hold_expired" | "slot_unavailable" | "too_soon" | "too_far" | "child_not_linked" | "invalid_transition" | "rate_limited" | "generic";

function errorCodeOf(status: number, json: Record<string, unknown>): ErrorCode {
  if (status === 429) return "rate_limited";
  const code = json.code;
  const known: ErrorCode[] = ["slot_taken", "hold_expired", "slot_unavailable", "too_soon", "too_far", "child_not_linked", "invalid_transition"];
  return known.includes(code as ErrorCode) ? (code as ErrorCode) : "generic";
}

function newKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function useCountdown(expiresAt: string | null): number {
  const [left, setLeft] = useState(() => (expiresAt ? Math.max(0, Date.parse(expiresAt) - Date.now()) : 0));
  useEffect(() => {
    if (!expiresAt) return;
    const tick = () => setLeft(Math.max(0, Date.parse(expiresAt) - Date.now()));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);
  return left;
}

// FR-7 booking flow: service -> date strip -> time -> Continue (10-minute hold with countdown) -> sign in if needed
// (the hold id stays in the URL and the anonymous hold is attached at confirm) -> child -> disclosure -> confirm.
export function BookingFlow({ profile, services, viewer, initialHold }: Props) {
  const t = useT("booking");
  const locale = useLocale();
  const viewerTz = useTimeZone();
  const format = useFormatter();
  const router = useRouter();
  const [serviceId, setServiceId] = useState(initialHold?.serviceId ?? services[0]?.id ?? "");
  const [picked, setPicked] = useState<PickedSlot | null>(null);
  const [hold, setHold] = useState<FlowHold | null>(initialHold);
  const [childId, setChildId] = useState(viewer.children.length === 1 ? viewer.children[0].id : "");
  const [error, setError] = useState<ErrorCode | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<"confirmed" | "pending_payment" | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const holdKey = useRef<{ slot: string; key: string } | null>(null);
  const left = useCountdown(hold?.expiresAt ?? null);

  const service = services.find((s) => s.id === serviceId) ?? services[0];
  const clinicTz = service?.mode === "in_clinic" ? service.time_zone : null;
  const expired = Boolean(hold) && left <= 0;
  const child = viewer.children.find((c) => c.id === childId);
  const holdPath = (id: string) => `/book/${profile.id}?hold=${id}`;

  async function continueWithSlot() {
    if (!picked || !service) return;
    setBusy(true);
    setError(null);
    // Same selection -> same idempotency key, so a double tap or retry returns the same hold.
    if (!holdKey.current || holdKey.current.slot !== `${service.id}|${picked.start}`) {
      holdKey.current = { slot: `${service.id}|${picked.start}`, key: newKey() };
    }
    const res = await send("/api/appointments/hold", "POST", { service_id: service.id, start: picked.start, idempotency_key: holdKey.current.key });
    setBusy(false);
    if (res.ok && res.json.status === "held") {
      const id = res.json.appointment_id as string;
      setHold({ id, serviceId: service.id, start: picked.start, end: picked.end, expiresAt: res.json.hold_expires_at as string });
      router.replace(holdPath(id), { scroll: false });
      return;
    }
    holdKey.current = null;
    setError(res.ok ? "hold_expired" : errorCodeOf(res.status, res.json));
    setPicked(null);
    setRefreshKey((k) => k + 1);
  }

  async function confirm() {
    if (!hold || !childId) return;
    setBusy(true);
    setError(null);
    const res = await send(`/api/appointments/${hold.id}/confirm`, "POST", { child_id: childId });
    setBusy(false);
    if (res.ok) {
      const status = (res.json.appointment as { status: string } | undefined)?.status;
      // 031: online services continue on the checkout page.
      if (status === "pending_payment") {
        router.push(`/book/${profile.id}/pay/${hold.id}`);
        return;
      }
      setDone(status === "pending_payment" ? "pending_payment" : "confirmed");
      return;
    }
    const code = errorCodeOf(res.status, res.json);
    setError(code);
    if (code === "hold_expired" || res.status === 404) pickAgain(false);
  }

  function pickAgain(clearError = true) {
    setHold(null);
    setPicked(null);
    if (clearError) setError(null);
    holdKey.current = null;
    setRefreshKey((k) => k + 1);
    router.replace(`/book/${profile.id}`, { scroll: false });
  }

  if (!service) {
    return <p className="rounded border border-dashed border-slate-300 bg-white p-4 text-slate-700">{t("flow.noServices")}</p>;
  }

  const timeText = (start: string) => `${format.date(start, "long")}, ${slotTimeLabel(start, locale, viewerTz, clinicTz, (key, vars) => t(key, vars))}`;
  const fee = feeLabel(service.fee_inr, service.payment_mode, format.inr);
  const providerLabel = service.mode === "in_clinic" && service.location_name ? `${profile.name} (${service.location_name})` : profile.name;
  const errorBox = error ? (
    <p role="alert" className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">
      {t(`errors.${error}`)}
    </p>
  ) : null;

  if (done) {
    return (
      <div className="space-y-4 rounded-2xl border border-teal-200 bg-teal-50 p-4 sm:p-6" role="status">
        <h2 className="text-xl font-semibold text-teal-900">{done === "confirmed" ? t("flow.booked") : t("status.pending_payment")}</h2>
        {hold ? <p className="text-slate-800">{timeText(hold.start)}</p> : null}
        <p className="text-sm text-slate-700">{done === "confirmed" ? t("flow.bookedDetail") : t("flow.pendingPayment")}</p>
        <Link href="/family/appointments" className={buttonClass}>
          {t("flow.viewAppointments")}
        </Link>
      </div>
    );
  }

  const summary = (
    <dl className="grid gap-2 rounded-lg border border-slate-200 bg-white p-4 text-sm sm:grid-cols-2">
      <div>
        <dt className="font-semibold text-slate-900">{t("flow.service")}</dt>
        <dd className="text-slate-700">
          {service.name} · {t("duration", { minutes: service.duration_min })}
        </dd>
      </div>
      <div>
        <dt className="font-semibold text-slate-900">{t(`modes.${service.mode}`)}</dt>
        <dd className="text-slate-700">{service.mode === "in_clinic" ? [service.location_name, service.location_address].filter(Boolean).join(", ") : profile.name}</dd>
      </div>
      <div>
        <dt className="font-semibold text-slate-900">{t("flow.fee")}</dt>
        <dd className="text-slate-700">{fee ? `${fee} · ${t(`payment.${service.payment_mode}`)}` : t("payment.free")}</dd>
      </div>
    </dl>
  );

  if (hold) {
    const minutes = Math.floor(left / 60_000);
    const seconds = Math.floor((left % 60_000) / 1000);
    const loginHref = `/family/login?next=${encodeURIComponent(holdPath(hold.id))}`;
    return (
      <div className="space-y-5">
        {summary}
        <div className="space-y-1 rounded-lg border border-amber-200 bg-amber-50 p-4" aria-live="polite">
          <p className="font-medium text-amber-950">{t("flow.held", { time: timeText(hold.start) })}</p>
          {expired ? (
            <p role="alert" className="text-sm font-semibold text-red-800">{t("errors.hold_expired")}</p>
          ) : (
            <p className="text-sm text-amber-900" aria-live="off">
              {t("flow.countdown", { time: `${minutes}:${String(seconds).padStart(2, "0")}` })}
            </p>
          )}
        </div>
        {errorBox}
        {expired ? (
          <button type="button" className={buttonClass} onClick={() => pickAgain()}>
            {t("flow.changeTime")}
          </button>
        ) : !viewer.signedIn ? (
          <div className="space-y-3 rounded-lg border border-slate-200 bg-white p-4">
            <h2 className="text-lg font-semibold text-slate-900">{t("flow.signInTitle")}</h2>
            <p className="text-sm text-slate-700">{t("flow.signInHint")}</p>
            <Link href={loginHref} className={buttonClass}>
              {t("flow.signIn")}
            </Link>
          </div>
        ) : !viewer.isGuardian ? (
          <p role="alert" className="rounded border border-slate-200 bg-white p-4 text-sm text-slate-800">{t("flow.familyOnly")}</p>
        ) : (
          <div className="space-y-4">
            <fieldset className="space-y-2">
              <legend className="text-lg font-semibold text-slate-900">{t("flow.forWhichChild")}</legend>
              {viewer.children.length === 0 ? <p className="text-sm text-slate-700">{t("flow.noChildren")}</p> : null}
              {viewer.children.map((c) => (
                <label key={c.id} className="flex min-h-11 items-center gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900">
                  <input type="radio" name="child" value={c.id} checked={childId === c.id} onChange={() => setChildId(c.id)} className="h-5 w-5" />
                  <span>
                    <span className="font-medium">{c.name}</span> <span className="text-slate-600">· {c.age}</span>
                  </span>
                </label>
              ))}
              <Link href={`/family/children/new?next=${encodeURIComponent(holdPath(hold.id))}`} className={`${secondaryButtonClass} mt-1`}>
                {t("flow.addChild")}
              </Link>
            </fieldset>
            {child ? (
              <p className="rounded-lg bg-slate-100 p-3 text-sm text-slate-800" id="booking-disclosure">
                {t("flow.disclosure", { child: child.name, provider: providerLabel })}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-3">
              <button type="button" className={buttonClass} disabled={!child || busy} aria-describedby={child ? "booking-disclosure" : undefined} onClick={confirm}>
                {service.payment_mode === "online" ? t("flow.continueToPayment") : t("flow.confirm")}
              </button>
              <button type="button" className={secondaryButtonClass} disabled={busy} onClick={() => pickAgain()}>
                {t("flow.changeTime")}
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {viewer.signedIn && !viewer.isGuardian ? (
        <p role="note" className="rounded border border-slate-200 bg-white p-4 text-sm text-slate-800">{t("flow.familyOnly")}</p>
      ) : null}
      {services.length > 1 ? (
        <div>
          <label htmlFor="booking-service" className={labelClass}>
            {t("flow.service")}
          </label>
          <select
            id="booking-service"
            value={service.id}
            onChange={(e) => {
              setServiceId(e.target.value);
              setPicked(null);
              setError(null);
            }}
            className="mt-1 block min-h-11 w-full rounded border border-slate-300 bg-white px-3 py-2 text-base text-slate-900 sm:text-sm"
          >
            {services.map((s) => (
              <option key={s.id} value={s.id}>
                {`${s.name} · ${t("duration", { minutes: s.duration_min })} · ${t(`modes.${s.mode}`)}`}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {summary}
      {errorBox}
      <SlotPicker profileId={profile.id} serviceId={service.id} clinicTimeZone={clinicTz} selected={picked} onSelect={setPicked} refreshKey={refreshKey} />
      <button type="button" className={buttonClass} disabled={!picked || busy} onClick={continueWithSlot}>
        {t("flow.continue")}
      </button>
    </div>
  );
}
