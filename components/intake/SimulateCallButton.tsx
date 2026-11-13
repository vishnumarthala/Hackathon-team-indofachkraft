"use client";

import { useState } from "react";
import { useT } from "@/lib/i18n/client";

// English defaults (equal to the en catalogue intake.simulate.*); the button shows the viewer's translations.
export const SIMULATE_LABEL = "Simulate completed call (demo)";
export const SIMULATE_DONE = "Call ended. Thank you! You can close this page.";
export const SIMULATE_FAILED = "Could not simulate the call. Please try again.";

export type SimulateResult = { ok: true } | { ok: false; message: string };

// FR-7: replays the demo post-call fixture for this link (FR-6). Free of React so it can be tested.
export async function simulateIntake(
  token: string,
  fetchFn: (input: string, init?: RequestInit) => Promise<Response>,
  messages: { failed: string; notFound?: string } = { failed: SIMULATE_FAILED },
  path: string = `/api/dev/simulate-intake/${encodeURIComponent(token)}`,
): Promise<SimulateResult> {
  try {
    const res = await fetchFn(path, { method: "POST" });
    const body = (await res.json().catch(() => ({}))) as { received?: boolean; ignored?: string; error?: string };
    if (res.ok && body.received === true && !body.ignored) return { ok: true };
    // Translated callers pass notFound and never see the (English) API text; the default keeps it.
    if (messages.notFound) return { ok: false, message: res.status === 404 ? messages.notFound : messages.failed };
    return { ok: false, message: body.error ?? messages.failed };
  } catch {
    return { ok: false, message: messages.failed };
  }
}

/** `path`: 035 appointment intake simulator (`/api/dev/simulate-intake/a/<token>`); default the case-level one. */
export function SimulateCallButton({ token, path }: { token: string; path?: string }) {
  const t = useT("intake");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    setBusy(true);
    setError(null);
    const result = await simulateIntake(token, (input, init) => fetch(input, init), {
      failed: t("simulate.failed"),
      notFound: t("status.notFound"),
    }, path);
    if (result.ok) setDone(true);
    else setError(result.message);
    setBusy(false);
  }

  if (done) {
    return (
      <p role="status" className="mt-3 text-base font-medium text-slate-900">
        {t("simulate.done")}
      </p>
    );
  }

  return (
    <div className="mt-3 space-y-2">
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        className="min-h-12 w-full rounded border border-slate-900 bg-white px-4 py-3 text-base font-semibold text-slate-900 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {t("simulate.label")}
      </button>
      {error && (
        <p role="alert" className="text-base text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
