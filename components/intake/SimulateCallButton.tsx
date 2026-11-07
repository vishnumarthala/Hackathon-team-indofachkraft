"use client";

import { useState } from "react";

export const SIMULATE_LABEL = "Simulate completed call (demo)";
export const SIMULATE_DONE = "Call ended. Thank you! You can close this page.";
export const SIMULATE_FAILED = "Could not simulate the call. Please try again.";

export type SimulateResult = { ok: true } | { ok: false; message: string };

// FR-7: replays the demo post-call fixture for this link (FR-6). Free of React so it can be tested.
export async function simulateIntake(
  token: string,
  fetchFn: (input: string, init?: RequestInit) => Promise<Response>,
): Promise<SimulateResult> {
  try {
    const res = await fetchFn(`/api/dev/simulate-intake/${encodeURIComponent(token)}`, { method: "POST" });
    const body = (await res.json().catch(() => ({}))) as { received?: boolean; ignored?: string; error?: string };
    if (res.ok && body.received === true && !body.ignored) return { ok: true };
    return { ok: false, message: body.error ?? SIMULATE_FAILED };
  } catch {
    return { ok: false, message: SIMULATE_FAILED };
  }
}

export function SimulateCallButton({ token }: { token: string }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    setBusy(true);
    setError(null);
    const result = await simulateIntake(token, (input, init) => fetch(input, init));
    if (result.ok) setDone(true);
    else setError(result.message);
    setBusy(false);
  }

  if (done) {
    return (
      <p role="status" className="mt-3 text-base font-medium text-slate-900">
        {SIMULATE_DONE}
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
        {SIMULATE_LABEL}
      </button>
      {error && (
        <p role="alert" className="text-base text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
