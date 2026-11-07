"use client";

import { useState } from "react";
import { NETWORK_ERROR } from "./uploadFlow";

// idle: nothing running. working: swap or extraction in flight. cleared: speakers are swapped and
// the old ratings are gone, but the new extraction failed, so the form must not show anything.
export type SwapPhase = "idle" | "working" | "cleared";

async function call(url: string, method: string, body: unknown): Promise<{ ok: boolean; error: string }> {
  try {
    const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: res.ok, error: typeof json.error === "string" ? json.error : `Request failed (${res.status})` };
  } catch {
    return { ok: false, error: NETWORK_ERROR };
  }
}

export function SwapSpeakersButton({
  recordingId,
  onPhase,
}: {
  recordingId: string;
  onPhase: (phase: SwapPhase) => void;
}) {
  const [phase, setPhaseState] = useState<SwapPhase>("idle");
  const [error, setError] = useState<string | null>(null);

  function setPhase(next: SwapPhase) {
    setPhaseState(next);
    onPhase(next);
  }

  async function extract() {
    setPhase("working");
    setError(null);
    const res = await call(`/api/sessions/${recordingId}/extract`, "POST", {});
    if (res.ok) {
      // Reload so every panel shows the new extraction; the old ratings stay hidden until then.
      window.location.reload();
      return;
    }
    setError(res.error);
    setPhase("cleared");
  }

  async function swap() {
    setPhase("working");
    setError(null);
    const res = await call(`/api/sessions/${recordingId}/speakers`, "PATCH", { swap: true });
    if (!res.ok) {
      setError(res.error);
      setPhase("idle");
      return;
    }
    await extract();
  }

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        {phase !== "cleared" && (
          <button
            type="button"
            disabled={phase === "working"}
            onClick={() => void swap()}
            className="rounded border border-slate-400 px-3 py-1 text-sm font-medium text-slate-900 disabled:opacity-50"
          >
            Swap speakers
          </button>
        )}
        {phase === "cleared" && (
          <button
            type="button"
            onClick={() => void extract()}
            className="rounded bg-slate-900 px-3 py-1 text-sm font-medium text-white"
          >
            Retry
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
