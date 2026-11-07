"use client";

import { useState } from "react";

type Share = { url: string; whatsapp_url: string };

export type IntakeLinkCardProps = {
  caseId: string;
  initialShare: Share | null;
  hasParentEmail: boolean;
  callCompleted: boolean;
};

type LinkResponse = Share & { emailed?: boolean; email_error?: string; error?: string };

export function emailStatusText(res: { ok: boolean; body: LinkResponse }): string {
  if (!res.ok) return res.body.error ?? "Email could not be sent";
  if (res.body.email_error) return "Email could not be sent";
  return res.body.emailed ? "Email sent" : "Email not sent (demo mode)";
}

const buttonClass =
  "inline-flex min-h-11 items-center rounded px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60";

export function IntakeLinkCard({ caseId, initialShare, hasParentEmail, callCompleted }: IntakeLinkCardProps) {
  const [share, setShare] = useState<Share | null>(initialShare);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [emailStatus, setEmailStatus] = useState<string | null>(null);

  async function requestLink(sendEmail: boolean): Promise<{ ok: boolean; body: LinkResponse } | null> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/cases/${caseId}/intake-link`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sendEmail ? { send_email: true } : {}),
      });
      const body = (await res.json().catch(() => ({}))) as LinkResponse;
      if (res.ok && body.url) setShare({ url: body.url, whatsapp_url: body.whatsapp_url });
      return { ok: res.ok, body };
    } catch {
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function onCreate() {
    const res = await requestLink(false);
    if (!res || !res.ok) setError(res?.body.error ?? "Could not create the intake link");
  }

  async function onEmail() {
    setEmailStatus(null);
    const res = await requestLink(true);
    setEmailStatus(res ? emailStatusText(res) : "Email could not be sent");
  }

  async function onCopy() {
    if (!share) return;
    try {
      await navigator.clipboard.writeText(share.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Could not copy the link");
    }
  }

  return (
    <section aria-labelledby="intake-call-heading" className="rounded border border-slate-200 p-4">
      <h2 id="intake-call-heading" className="text-lg font-semibold">
        Intake call
      </h2>

      {share ? (
        <div className="mt-3 space-y-3">
          <div>
            <label htmlFor="intake-link" className="block text-sm font-medium text-slate-800">
              Intake link
            </label>
            <input
              id="intake-link"
              type="text"
              readOnly
              value={share.url}
              onFocus={(e) => e.currentTarget.select()}
              className="mt-1 w-full rounded border border-slate-300 bg-slate-50 px-3 py-2 font-mono text-sm"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={onCopy} className={`${buttonClass} bg-slate-900 text-white`}>
              {copied ? "Copied" : "Copy link"}
            </button>
            <a
              href={share.whatsapp_url}
              target="_blank"
              rel="noopener noreferrer"
              className={`${buttonClass} bg-emerald-600 text-white`}
            >
              Share on WhatsApp
            </a>
            <button
              type="button"
              onClick={onEmail}
              disabled={!hasParentEmail || busy}
              title={hasParentEmail ? undefined : "Add a parent email on the case first"}
              className={`${buttonClass} border border-slate-300 bg-white text-slate-900`}
            >
              Email to parent
            </button>
            {emailStatus && (
              <span role="status" className="text-sm text-slate-700">
                {emailStatus}
              </span>
            )}
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={onCreate}
          disabled={busy}
          className={`${buttonClass} mt-3 bg-slate-900 text-white`}
        >
          Create intake link
        </button>
      )}

      {error && (
        <p role="alert" className="mt-2 text-sm text-red-700">
          {error}
        </p>
      )}

      <p className="mt-3 text-sm text-slate-700">
        {callCompleted ? "Intake call completed" : "Waiting for the parent to complete the call"}
      </p>
    </section>
  );
}
