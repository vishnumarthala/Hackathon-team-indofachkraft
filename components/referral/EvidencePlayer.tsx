"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

export type AudioUrls = Record<string, string | null>;

export type EvidencePlayerApi = {
  /** Plays the recording from `startSec`. Returns false when that recording has no playable audio. */
  play: (recordingId: string, startSec: number) => boolean;
  stop: () => void;
  canPlay: (recordingId: string) => boolean;
  /** The moment currently playing, or null. */
  current: { recordingId: string; startSec: number } | null;
};

const EvidencePlayerContext = createContext<EvidencePlayerApi | null>(null);

/**
 * One hidden <audio> element for a page. `audioUrls` maps recording ids to signed URLs (valid 1 hour)
 * or null when a recording has no audio.
 */
export function EvidencePlayerProvider({ audioUrls, children }: { audioUrls: AudioUrls; children: ReactNode }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const pendingRef = useRef<(() => void) | null>(null);
  const [current, setCurrent] = useState<EvidencePlayerApi["current"]>(null);

  const canPlay = useCallback((recordingId: string) => Boolean(audioUrls[recordingId]), [audioUrls]);

  const stop = useCallback(() => {
    audioRef.current?.pause();
    setCurrent(null);
  }, []);

  const play = useCallback(
    (recordingId: string, startSec: number) => {
      const audio = audioRef.current;
      const url = audioUrls[recordingId];
      if (!audio || !url) return false;
      const start = Math.max(0, startSec);
      const begin = () => {
        pendingRef.current = null;
        audio.currentTime = start;
        audio.play().catch(() => setCurrent(null));
      };
      if (audio.dataset.recordingId !== recordingId) {
        audio.pause();
        if (pendingRef.current) audio.removeEventListener("loadedmetadata", pendingRef.current);
        pendingRef.current = begin;
        audio.dataset.recordingId = recordingId;
        audio.src = url;
        audio.addEventListener("loadedmetadata", begin, { once: true });
        audio.load();
      } else if (audio.readyState === 0 && pendingRef.current) {
        audio.removeEventListener("loadedmetadata", pendingRef.current);
        pendingRef.current = begin;
        audio.addEventListener("loadedmetadata", begin, { once: true });
      } else {
        begin();
      }
      setCurrent({ recordingId, startSec: start });
      return true;
    },
    [audioUrls],
  );

  const api = useMemo<EvidencePlayerApi>(() => ({ play, stop, canPlay, current }), [play, stop, canPlay, current]);

  return (
    <EvidencePlayerContext.Provider value={api}>
      {children}
      <audio ref={audioRef} hidden preload="none" onEnded={() => setCurrent(null)} onError={() => setCurrent(null)} />
    </EvidencePlayerContext.Provider>
  );
}

export function useEvidencePlayer(): EvidencePlayerApi {
  const api = useContext(EvidencePlayerContext);
  if (!api) throw new Error("useEvidencePlayer must be used inside EvidencePlayerProvider");
  return api;
}

/** A `Session <n> · <mm:ss>` button that plays the moment, or plain text when the recording has no audio. */
export function EvidenceTimestamp({
  recordingId,
  startSec,
  label,
}: {
  recordingId: string;
  startSec: number;
  label: string;
}) {
  const { play, canPlay, current } = useEvidencePlayer();
  if (!canPlay(recordingId)) {
    return <span className="text-sm text-slate-600">{label}</span>;
  }
  const active = current?.recordingId === recordingId && current.startSec === Math.max(0, startSec);
  return (
    <button
      type="button"
      onClick={() => play(recordingId, startSec)}
      aria-pressed={active}
      className={`rounded border px-2 py-1 text-sm font-medium ${
        active ? "border-sky-700 bg-sky-700 text-white" : "border-sky-300 bg-sky-50 text-sky-900 hover:bg-sky-100"
      }`}
    >
      {label}
    </button>
  );
}
