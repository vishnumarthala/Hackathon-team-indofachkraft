"use client";

import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { collectRedFlags, recommend, scoreIsaa, type ExtractionRedFlagInput } from "@/lib/scoring";
import type { FactRow, Segment } from "@/lib/types";
import { AudioTranscript } from "./AudioTranscript";
import { BulkActions } from "./BulkActions";
import { IsaaForm } from "./IsaaForm";
import { ratingValue } from "./ItemRow";
import { ScorePanel } from "./ScorePanel";
import { swapSegments } from "@/lib/speaker-swap";
import { SwapSpeakersButton, type SwapPhase } from "./SwapSpeakersButton";

const RED_FLAG_TEXT: Record<string, string> = {
  lost_speech: "Red flag: lost speech",
  self_injury: "Red flag: self-injury",
};

async function send(url: string, method: string, body: unknown): Promise<{ ok: boolean; json: Record<string, unknown> }> {
  try {
    const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: res.ok, json };
  } catch {
    return { ok: false, json: { error: "Network error - try again" } };
  }
}

function errorText(json: Record<string, unknown>): string {
  return typeof json.error === "string" ? json.error : "Could not save";
}

export function ReviewScreen({
  recordingId,
  sessionNumber,
  audioUrl,
  segments,
  facts: serverFacts,
  extractionRedFlags,
  facpScore,
  needsReextraction = false,
}: {
  recordingId: string;
  sessionNumber: number | null;
  audioUrl: string | null;
  segments: Segment[];
  facts: FactRow[];
  extractionRedFlags: ExtractionRedFlagInput[];
  facpScore: number | null;
  needsReextraction?: boolean;
}) {
  const router = useRouter();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [facts, setFacts] = useState(serverFacts);
  const [syncedFrom, setSyncedFrom] = useState(serverFacts);
  const [activeSegmentId, setActiveSegmentId] = useState<string | null>(null);
  const [busyFactId, setBusyFactId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [swapPhase, setSwapPhase] = useState<SwapPhase>(needsReextraction ? "cleared" : "idle");
  const [swappedSegments, setSwappedSegments] = useState<Segment[] | null>(null);

  // After router.refresh() the server sends fresh facts: adopt them.
  if (serverFacts !== syncedFrom) {
    setSyncedFrom(serverFacts);
    setFacts(serverFacts);
  }

  const scoringFacts = useMemo(
    () => facts.map((f) => ({ item_id: f.item_id, value: ratingValue(f.value), status: f.status })),
    [facts],
  );
  const score = useMemo(() => scoreIsaa(scoringFacts), [scoringFacts]);
  const redFlags = useMemo(
    () => collectRedFlags({ isaaFacts: scoringFacts, extractionRedFlags }),
    [scoringFacts, extractionRedFlags],
  );
  const recommendation = useMemo(() => recommend({ isaa: score, facpScore, redFlags }), [score, facpScore, redFlags]);

  const suggestedCount = facts.filter((f) => f.status === "suggested" && ratingValue(f.value) !== null).length;
  const unratedCount = facts.filter((f) => ratingValue(f.value) === null).length;

  function seek(segmentId: string, startSec: number) {
    setActiveSegmentId(segmentId);
    const audio = audioRef.current;
    if (audio) {
      audio.currentTime = startSec;
      void audio.play().catch(() => {});
    }
    document.getElementById(`seg-${segmentId}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  async function update(fact: FactRow, body: { action: "confirm" } | { action: "edit"; value: number }) {
    setBusyFactId(fact.id);
    setErrors((current) => {
      const next = { ...current };
      delete next[fact.id];
      return next;
    });
    const { ok, json } = await send(`/api/facts/${fact.id}`, "PATCH", body);
    if (ok && json.fact) {
      const updated = json.fact as FactRow;
      setFacts((current) => current.map((f) => (f.id === updated.id ? updated : f)));
    } else {
      setErrors((current) => ({ ...current, [fact.id]: errorText(json) }));
    }
    setBusyFactId(null);
  }

  async function runBulk(action: "confirm_suggested" | "rate_unrated") {
    setBulkBusy(true);
    setBulkError(null);
    const body = action === "rate_unrated" ? { action, value: 1 } : { action };
    const { ok, json } = await send(`/api/sessions/${recordingId}/bulk`, "POST", body);
    if (ok) router.refresh();
    else setBulkError(errorText(json));
    setBulkBusy(false);
  }

  return (
    <div className="space-y-4">
      {swapPhase === "idle" && redFlags.length > 0 && (
        <div role="alert" className="rounded border border-red-300 bg-red-50 px-4 py-3 font-semibold text-red-800">
          {redFlags.map((flag) => RED_FLAG_TEXT[flag.type]).join(" · ")} - consider referral
        </div>
      )}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <AudioTranscript
          sessionNumber={sessionNumber}
          audioUrl={audioUrl}
          audioRef={audioRef}
          segments={swappedSegments ?? segments}
          activeSegmentId={activeSegmentId}
          onSelect={seek}
          headerAction={(
            <SwapSpeakersButton
              recordingId={recordingId}
              initialPhase={swapPhase}
              onPhase={setSwapPhase}
              onSwapped={() => setSwappedSegments(swapSegments(segments))}
            />
          )}
        />
        {swapPhase !== "idle" ? (
          <p role="status" className="min-w-0 rounded border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-800">
            {swapPhase === "working"
              ? "Swapping speakers and filling the ISAA form again. The earlier ratings were cleared and stay hidden until the AI finishes."
              : "The earlier ratings were cleared because the speakers were swapped, and the AI could not fill the form again. Retry to get new suggestions."}
          </p>
        ) : (
          <div className="min-w-0 space-y-4">
            <ScorePanel score={score} facpScore={facpScore} recommendation={recommendation} />
            <BulkActions
              suggestedCount={suggestedCount}
              unratedCount={unratedCount}
              busy={bulkBusy}
              error={bulkError}
              onRun={runBulk}
            />
            <IsaaForm
              facts={facts}
              busyFactId={busyFactId}
              errors={errors}
              onRate={(fact, value) => update(fact, { action: "edit", value })}
              onConfirm={(fact) => update(fact, { action: "confirm" })}
              onSeek={seek}
            />
          </div>
        )}
      </div>
    </div>
  );
}
