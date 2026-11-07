"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

type EmailStatus = "sent" | "demo" | "failed";
type Success = { url: string; email: string; emailStatus: EmailStatus };

const FIELD_CLASS = "mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm";

function emailMessage(status: EmailStatus, email: string): string {
  if (status === "sent") return `Email sent to ${email}`;
  if (status === "demo") return "Email not sent (demo mode)";
  return "Email could not be sent";
}

export function ReferralForm({ caseId, defaultReason }: { caseId: string; defaultReason: string }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [reason, setReason] = useState(defaultReason);
  const [consent, setConsent] = useState(false);
  const [sending, setSending] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<Success | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!consent) return;
    setSending(true);
    setErrors({});
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch(`/api/cases/${caseId}/refer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ specialist_name: name, specialist_email: email, reason, parent_consent: consent }),
      });
      const json = await res.json().catch(() => ({}));
      if (res.status === 201) {
        const status: EmailStatus = json.email_status ?? (json.emailed ? "sent" : "failed");
        setSuccess({ url: json.url, email: email.trim(), emailStatus: status });
        router.refresh();
      } else {
        if (json.details && typeof json.details === "object") setErrors(json.details);
        setError(json.error ?? "Referral could not be sent");
      }
    } catch {
      setError("Referral could not be sent");
    }
    setSending(false);
  }

  return (
    <div className="space-y-4">
      <form onSubmit={onSubmit} noValidate className="max-w-xl space-y-4">
        <div>
          <label htmlFor="specialist_name" className="block text-sm font-medium text-slate-800">
            Specialist name
          </label>
          <input
            id="specialist_name"
            name="specialist_name"
            value={name}
            maxLength={100}
            onChange={(e) => setName(e.target.value)}
            aria-invalid={Boolean(errors.specialist_name)}
            aria-describedby={errors.specialist_name ? "specialist_name_error" : undefined}
            className={FIELD_CLASS}
          />
          {errors.specialist_name && (
            <p id="specialist_name_error" className="mt-1 text-sm text-red-700">
              {errors.specialist_name}
            </p>
          )}
        </div>
        <div>
          <label htmlFor="specialist_email" className="block text-sm font-medium text-slate-800">
            Specialist email
          </label>
          <input
            id="specialist_email"
            name="specialist_email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-invalid={Boolean(errors.specialist_email)}
            aria-describedby={errors.specialist_email ? "specialist_email_error" : undefined}
            className={FIELD_CLASS}
          />
          {errors.specialist_email && (
            <p id="specialist_email_error" className="mt-1 text-sm text-red-700">
              {errors.specialist_email}
            </p>
          )}
        </div>
        <div>
          <label htmlFor="reason" className="block text-sm font-medium text-slate-800">
            Reason for referral
          </label>
          <textarea
            id="reason"
            name="reason"
            rows={4}
            maxLength={1000}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            aria-invalid={Boolean(errors.reason)}
            aria-describedby={errors.reason ? "reason_error" : undefined}
            className={FIELD_CLASS}
          />
          {errors.reason && (
            <p id="reason_error" className="mt-1 text-sm text-red-700">
              {errors.reason}
            </p>
          )}
        </div>
        <div>
          <div className="flex items-start gap-2">
            <input
              id="parent_consent"
              name="parent_consent"
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
              className="mt-1"
            />
            <label htmlFor="parent_consent" className="text-sm text-slate-800">
              The parent consented to share this case with the specialist
            </label>
          </div>
          {errors.parent_consent && <p className="mt-1 text-sm text-red-700">{errors.parent_consent}</p>}
        </div>
        <button
          type="submit"
          disabled={!consent || sending}
          className="rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
        >
          {sending ? "Sending…" : "Send referral"}
        </button>
        {error && (
          <p role="alert" className="text-sm text-red-700">
            {error}
          </p>
        )}
      </form>

      {success && (
        <div role="status" className="max-w-xl rounded border border-emerald-200 bg-emerald-50 p-4 text-emerald-950">
          <p className="font-semibold">Referral sent</p>
          <p className="mt-1 break-all text-sm">{success.url}</p>
          <a href={success.url} target="_blank" rel="noreferrer" className="mt-2 inline-block text-sm font-medium underline">
            Open specialist view
          </a>
          <p className="mt-2 text-sm">{emailMessage(success.emailStatus, success.email)}</p>
        </div>
      )}
    </div>
  );
}
