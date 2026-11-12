"use client";

import { useEffect, useId, useState, type FormEvent } from "react";
import { useT } from "@/lib/i18n/client";
import { maskPhone, MOBILE_ERROR, normalizeIndianMobile, OTP_CODE_ERROR, WRONG_CODE_ERROR } from "@/lib/family/phone";

export const RESEND_AFTER_SECONDS = 60;

export const inputClass =
  "block min-h-12 w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-base text-slate-900 focus:border-teal-600 focus:outline-none focus:ring-4 focus:ring-teal-600/15";
export const primaryButtonClass =
  "inline-flex min-h-12 w-full cursor-pointer items-center justify-center rounded-full bg-[#0b1f1d] px-6 py-3 font-semibold text-white hover:bg-teal-800 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-600/40 disabled:cursor-wait disabled:opacity-60";
export const secondaryButtonClass =
  "inline-flex min-h-11 cursor-pointer items-center justify-center rounded-full border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-800 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-600/30 disabled:cursor-not-allowed disabled:opacity-50";

type ErrorKey = "invalidMobile" | "invalidCode" | "wrongCode" | "tooMany" | "phoneInUse";

/** Maps API error bodies (English contract) to translated messages. */
function errorKeyFor(status: number, error: unknown): ErrorKey | null {
  if (status === 429) return "tooMany";
  if (status === 409) return "phoneInUse";
  if (error === MOBILE_ERROR) return "invalidMobile";
  if (error === OTP_CODE_ERROR) return "invalidCode";
  if (status === 400 && error === WRONG_CODE_ERROR) return "wrongCode";
  return null;
}

type Props = {
  sendUrl: string;
  verifyUrl: string;
  /** Extra JSON fields for the verify request (e.g. `next`). */
  verifyExtra?: Record<string, string>;
  onVerified: (body: Record<string, unknown>) => void;
  onCancel?: () => void;
};

/** FR-1 / FR-9: phone number with a fixed +91 prefix, then a 6-digit code; resend after 60 s. */
export function PhoneOtpForm({ sendUrl, verifyUrl, verifyExtra, onVerified, onCancel }: Props) {
  const t = useT("family.login");
  const tCommon = useT("errors");
  const tSettings = useT("family.settings");
  const id = useId();
  const [mobile, setMobile] = useState("");
  const [phone, setPhone] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(0);

  useEffect(() => {
    if (secondsLeft <= 0) return;
    const timer = setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [secondsLeft]);

  function message(status: number, body: { error?: unknown }): string {
    const key = errorKeyFor(status, body.error);
    if (key === "phoneInUse") return tSettings("phoneInUse");
    return key ? t(key) : tCommon("generic");
  }

  async function post(url: string, body: Record<string, string>) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { res, json };
  }

  async function send(target: string) {
    setBusy(true);
    setError("");
    try {
      const { res, json } = await post(sendUrl, { phone: target.slice(2) });
      if (!res.ok) {
        setError(message(res.status, json));
        return false;
      }
      setSecondsLeft(RESEND_AFTER_SECONDS);
      return true;
    } catch {
      setError(tCommon("generic"));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function submitPhone(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized = normalizeIndianMobile(mobile);
    if (!normalized) {
      setError(t("invalidMobile"));
      return;
    }
    if (await send(normalized)) {
      setPhone(normalized);
      setCode("");
    }
  }

  async function submitCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!phone) return;
    if (!/^\d{6}$/.test(code)) {
      setError(t("invalidCode"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      const { res, json } = await post(verifyUrl, { phone: phone.slice(2), code, ...verifyExtra });
      if (!res.ok) {
        setError(message(res.status, json));
        setBusy(false);
        return;
      }
      onVerified(json);
    } catch {
      setError(tCommon("generic"));
      setBusy(false);
    }
  }

  const errorBox = error ? (
    <p id={`${id}-error`} role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
      {error}
    </p>
  ) : null;

  if (!phone) {
    return (
      <form className="space-y-4" onSubmit={submitPhone} noValidate>
        <div>
          <label htmlFor={`${id}-mobile`} className="block text-sm font-semibold text-slate-900">
            {t("mobile")}
          </label>
          <div className="mt-1.5 flex items-stretch gap-2">
            <span
              aria-label={t("countryCode")}
              className="flex min-h-12 items-center rounded-xl border border-slate-300 bg-slate-50 px-3 text-base font-medium text-slate-700"
            >
              +91
            </span>
            <input
              id={`${id}-mobile`}
              autoComplete="tel-national"
              inputMode="numeric"
              maxLength={10}
              className={inputClass}
              value={mobile}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `${id}-error` : undefined}
              onChange={(event) => setMobile(event.target.value.replace(/[^\d]/g, "").slice(0, 10))}
            />
          </div>
        </div>
        {errorBox}
        <button type="submit" className={primaryButtonClass} disabled={busy}>
          {busy ? t("sending") : t("sendCode")}
        </button>
        {onCancel ? (
          <button type="button" className={`${secondaryButtonClass} w-full`} onClick={onCancel}>
            {tSettings("cancel")}
          </button>
        ) : null}
      </form>
    );
  }

  return (
    <form className="space-y-4" onSubmit={submitCode} noValidate>
      <p className="text-sm text-slate-700" aria-live="polite">
        {t("codeSent", { phone: maskPhone(phone) })}
      </p>
      <div>
        <label htmlFor={`${id}-code`} className="block text-sm font-semibold text-slate-900">
          {t("code")}
        </label>
        <input
          id={`${id}-code`}
          autoComplete="one-time-code"
          inputMode="numeric"
          maxLength={6}
          className={`${inputClass} mt-1.5`}
          value={code}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          onChange={(event) => setCode(event.target.value.replace(/[^\d]/g, "").slice(0, 6))}
        />
      </div>
      {errorBox}
      <button type="submit" className={primaryButtonClass} disabled={busy}>
        {busy ? t("verifying") : t("verify")}
      </button>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          className={secondaryButtonClass}
          disabled={busy || secondsLeft > 0}
          onClick={() => void send(phone)}
        >
          {secondsLeft > 0 ? t("resendIn", { seconds: secondsLeft }) : t("resend")}
        </button>
        <button
          type="button"
          className="min-h-11 cursor-pointer px-2 text-sm font-semibold text-teal-800 underline-offset-4 hover:underline"
          onClick={() => {
            setPhone(null);
            setError("");
            setSecondsLeft(0);
            onCancel?.();
          }}
        >
          {onCancel ? tSettings("cancel") : t("changeNumber")}
        </button>
      </div>
    </form>
  );
}
