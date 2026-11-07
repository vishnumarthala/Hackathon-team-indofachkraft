"use client";

import type { ReactNode, RefObject } from "react";
import type { Segment } from "@/lib/types";
import { formatClock } from "./time";

const SPEAKER_LABELS: Record<string, string> = {
  therapist: "Therapist",
  parent: "Parent",
  agent: "Agent",
  unknown: "Speaker",
};

export function AudioTranscript({
  sessionNumber,
  audioUrl,
  audioRef,
  segments,
  activeSegmentId,
  onSelect,
  headerAction,
}: {
  sessionNumber: number | null;
  audioUrl: string | null;
  audioRef: RefObject<HTMLAudioElement | null>;
  segments: Segment[];
  activeSegmentId: string | null;
  onSelect: (segmentId: string, startSec: number) => void;
  headerAction?: ReactNode;
}) {
  return (
    <div className="min-w-0 space-y-3 lg:sticky lg:top-4 lg:self-start">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h2 className="text-lg font-semibold">Session {sessionNumber}</h2>
        {headerAction}
      </div>
      {audioUrl ? (
        <audio ref={audioRef} controls preload="metadata" src={audioUrl} className="w-full" />
      ) : (
        <p className="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
          No audio uploaded for this session (transcript only).
        </p>
      )}
      <ol
        aria-label="Transcript"
        className="max-h-[70vh] space-y-1 overflow-y-auto rounded border border-slate-200 p-1"
      >
        {segments.map((segment) => {
          const active = segment.id === activeSegmentId;
          return (
            <li
              key={segment.id}
              id={`seg-${segment.id}`}
              data-active={active ? "true" : undefined}
              className={`rounded ${active ? "bg-amber-100 ring-1 ring-amber-400" : "hover:bg-slate-50"}`}
            >
              <button
                type="button"
                onClick={() => onSelect(segment.id, segment.start_sec)}
                className="block w-full px-2 py-1.5 text-left text-sm"
              >
                <span className="mr-2 font-semibold text-slate-900">
                  {SPEAKER_LABELS[segment.speaker] ?? segment.speaker}
                </span>
                <span className="mr-2 font-mono text-xs text-slate-500">{formatClock(segment.start_sec)}</span>
                <span className="text-slate-800">{segment.text}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
