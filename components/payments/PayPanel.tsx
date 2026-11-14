"use client";

import Link from "next/link";
import Script from "next/script";
import { useEffect, useState } from "react";
import { secondaryButtonClass, send } from "@/components/providers/request";
import { useT } from "@/lib/i18n/client";
import { Button } from "@/components/ui/Button";

// Same URL as lib/payments/razorpay.ts CHECKOUT_SCRIPT_URL (that module is server-only). Allowed on this route only:
// lib/csp.ts FAMILY_CSP_EXCEPTIONS["/book/*/pay/*"] + lib/privacy/third-party-allowlist.ts.
const CHECKOUT_SCRIPT = "https://checkout.razorpay.com/v1/checkout.js";

export type PayState = "payable" | "paid" | "refunded" | "expired" | "cancelled" | "nothing";

type CheckoutResponse = { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string };
type RazorpayInstance = { open(): void; on(event: "payment.failed", cb: () => void): void };
type RazorpayCtor = new (options: Record<string, unknown>) => RazorpayInstance;

type ErrorCode = "not_configured" | "gateway_error" | "invalid_signature" | "hold_expired" | "already_paid" | "generic";
type Notice = "failed" | "dismissed" | null;

function errorCode(json: Record<string, unknown>): ErrorCode {
  const known: ErrorCode[] = ["not_configured", "gateway_error", "invalid_signature", "hold_expired", "already_paid"];
  return known.includes(json.code as ErrorCode) ? (json.code as ErrorCode) : "generic";
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

type Props = {
  appointmentId: string;
  profileId: string;
  initialState: PayState;
  expiresAt: string | null;
  demo: boolean;
  description: string;
};

// 031 FR-4: `Pay now` -> POST /api/appointments/:id/payment-order -> Razorpay Checkout (test mode) -> success handler
// POST /api/payments/verify. DEMO_MODE: no Razorpay script; a demo checkout simulates success (signed by the server and
// verified through the same route) or failure.
export function PayPanel({ appointmentId, profileId, initialState, expiresAt, demo, description }: Props) {
  const t = useT("payments.pay");
  const [state, setState] = useState<PayState>(initialState);
  const [busy, setBusy] = useState<"opening" | "confirming" | null>(null);
  const [error, setError] = useState<ErrorCode | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [demoOpen, setDemoOpen] = useState(false);
  const left = useCountdown(state === "payable" ? expiresAt : null);
  const timeUp = state === "payable" && Boolean(expiresAt) && left <= 0;

  async function verify(response: CheckoutResponse) {
    setBusy("confirming");
    const res = await send("/api/payments/verify", "POST", response);
    setBusy(null);
    if (!res.ok) {
      setError(errorCode(res.json));
      return;
    }
    const outcome = String(res.json.outcome ?? "");
    setState(outcome.startsWith("refund_") || res.json.payment_status === "refund_pending" ? "refunded" : "paid");
  }

  async function payNow() {
    setError(null);
    setNotice(null);
    setBusy("opening");
    const res = await send(`/api/appointments/${appointmentId}/payment-order`, "POST");
    if (!res.ok) {
      setBusy(null);
      const code = errorCode(res.json);
      if (code === "hold_expired") setState("expired");
      else if (code === "already_paid") setState("paid");
      else setError(code);
      return;
    }
    if (res.json.demo === true) {
      setBusy(null);
      setDemoOpen(true);
      return;
    }
    const Razorpay = (window as unknown as { Razorpay?: RazorpayCtor }).Razorpay;
    if (!Razorpay) {
      setBusy(null);
      setError("generic");
      return;
    }
    const checkout = new Razorpay({
      key: res.json.key_id,
      order_id: res.json.order_id,
      amount: res.json.amount_paise,
      currency: res.json.currency,
      name: "DoctorNearMe",
      description,
      prefill: res.json.prefill,
      handler: (response: CheckoutResponse) => void verify(response),
      modal: { ondismiss: () => setNotice((n) => n ?? "dismissed") },
    });
    checkout.on("payment.failed", () => setNotice("failed"));
    setBusy(null);
    checkout.open();
  }

  async function simulate(outcome: "success" | "failure") {
    setError(null);
    setNotice(null);
    setBusy(outcome === "success" ? "confirming" : "opening");
    const res = await send("/api/payments/demo", "POST", { appointment_id: appointmentId, outcome });
    setBusy(null);
    if (!res.ok) {
      setError(errorCode(res.json));
      return;
    }
    setDemoOpen(false);
    if (outcome === "failure") {
      setNotice("failed");
      return;
    }
    await verify(res.json as unknown as CheckoutResponse);
  }

  if (state === "paid" || state === "refunded") {
    return (
      <div role="status" className="space-y-3 rounded-2xl border border-teal-200 bg-teal-50 p-4 sm:p-6">
        <h2 className="text-xl font-semibold text-teal-900">{state === "paid" ? t("paid") : t("refundStarted")}</h2>
        {state === "paid" ? <p className="text-sm text-slate-700">{t("paidDetail")}</p> : null}
        {/* 052 FR-6: after paying, "What happens next" on the appointment page. */}
        <Button href={state === "paid" ? `/family/appointments/${appointmentId}?booked=1` : "/family/appointments"}>
          {t("viewAppointments")}
        </Button>
      </div>
    );
  }
  if (state !== "payable" || timeUp) {
    const text = state === "cancelled" ? t("cancelled") : state === "nothing" ? t("nothingToPay") : t("expired");
    return (
      <div role="status" className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4 sm:p-6">
        <p className="text-slate-800">{text}</p>
        <div className="flex flex-wrap gap-2">
          {state !== "cancelled" && state !== "nothing" ? (
            <Button href={`/book/${profileId}`}>
              {t("pickAgain")}
            </Button>
          ) : null}
          <Link href="/family/appointments" className={secondaryButtonClass}>
            {t("viewAppointments")}
          </Link>
        </div>
      </div>
    );
  }

  const minutes = Math.floor(left / 60_000);
  const seconds = Math.floor((left % 60_000) / 1000);
  return (
    <div className="space-y-4">
      {!demo ? <Script src={CHECKOUT_SCRIPT} strategy="afterInteractive" /> : null}
      <p role="timer" aria-live="off" className="rounded bg-amber-50 px-3 py-2 text-sm font-medium text-amber-900">
        {t("countdown", { time: `${minutes}:${String(seconds).padStart(2, "0")}` })}
      </p>
      {error ? (
        <p role="alert" className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          {t(`errors.${error}`)}
        </p>
      ) : null}
      {notice ? (
        <p role="alert" className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          {t(notice)}
        </p>
      ) : null}
      {demoOpen ? (
        <section aria-labelledby="demo-checkout" className="space-y-3 rounded-2xl border-2 border-dashed border-violet-300 bg-violet-50 p-4">
          <h2 id="demo-checkout" className="font-semibold text-violet-900">
            {t("demoTitle")}
          </h2>
          <p className="text-sm text-violet-900">{t("demoNote")}</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" disabled={busy !== null} onClick={() => void simulate("success")}>
              {t("demoSuccess")}
            </Button>
            <button type="button" className={secondaryButtonClass} disabled={busy !== null} onClick={() => void simulate("failure")}>
              {t("demoFailure")}
            </button>
          </div>
        </section>
      ) : (
        <Button type="button" className="w-full sm:w-auto" disabled={busy !== null} onClick={() => void payNow()}>
          {busy === "opening" ? t("opening") : busy === "confirming" ? t("confirming") : t("payNow")}
        </Button>
      )}
      {busy === "confirming" ? (
        <p role="status" className="text-sm text-slate-700">
          {t("confirming")}
        </p>
      ) : null}
    </div>
  );
}
