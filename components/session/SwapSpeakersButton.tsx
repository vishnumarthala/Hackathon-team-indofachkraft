"use client";

import { useState } from "react";
import { browserCall, reExtract, swapAndExtract, type SwapOutcome, type SwapPhase } from "./swapFlow";
import { Button } from "@/components/ui/Button";

export type { SwapPhase } from "./swapFlow";

export function SwapSpeakersButton({
  recordingId,
  initialPhase,
  onPhase,
  onSwapped,
}: {
  recordingId: string;
  initialPhase: SwapPhase;
  onPhase: (phase: SwapPhase) => void;
  onSwapped: () => void;
}) {
  const [phase, setPhaseState] = useState<SwapPhase>(initialPhase);
  const [error, setError] = useState<string | null>(null);

  function setPhase(next: SwapPhase) {
    setPhaseState(next);
    onPhase(next);
  }

  function finish(outcome: SwapOutcome) {
    // Reload so every panel shows the server state; the old ratings stay hidden until then.
    if (outcome.reload) {
      window.location.reload();
      return;
    }
    setError(outcome.error);
    setPhase(outcome.phase);
  }

  async function swap() {
    setPhase("working");
    setError(null);
    finish(await swapAndExtract(recordingId, browserCall, onSwapped));
  }

  async function retry() {
    setPhase("working");
    setError(null);
    finish(await reExtract(recordingId, browserCall));
  }

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        {phase !== "cleared" ? (
          <button
            type="button"
            disabled={phase === "working"}
            onClick={() => void swap()}
            className="rounded border border-slate-400 px-3 py-1 text-sm font-medium text-slate-900 disabled:opacity-50"
          >
            Swap speakers
          </button>
        ) : (
          <Button
            type="button"
            onClick={() => void retry()}
            size="sm"
          >
            Retry
          </Button>
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
