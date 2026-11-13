"use client";

import { useCallback, useEffect, useRef } from "react";
import { callSeconds, SilenceWatch } from "@/lib/voice/client";

/**
 * 051 FR-6 / FR-7 for a live ElevenLabs call: ends the call after 30 s without speech from the user (while the agent
 * is not speaking) and measures the connected time for the end report. Call `connected()` from `onConnect`, `heard()`
 * for every user transcript, and read `seconds()` when the call ends.
 */
export function useVoiceCallGuard(opts: { live: boolean; isSpeaking: boolean; onSilence: () => void }) {
  const watch = useRef<SilenceWatch | null>(null);
  const connectedAt = useRef<number | null>(null);
  const fired = useRef(false);
  const onSilence = useRef(opts.onSilence);
  useEffect(() => {
    onSilence.current = opts.onSilence;
  }, [opts.onSilence]);

  useEffect(() => {
    if (!opts.live) return;
    watch.current ??= new SilenceWatch(Date.now());
    const timer = setInterval(() => {
      if (fired.current || !watch.current?.silent(Date.now())) return;
      fired.current = true;
      onSilence.current();
    }, 1000);
    return () => clearInterval(timer);
  }, [opts.live]);

  useEffect(() => {
    watch.current?.speaking(opts.isSpeaking, Date.now());
  }, [opts.isSpeaking]);

  const connected = useCallback(() => {
    connectedAt.current ??= Date.now();
    watch.current = new SilenceWatch(Date.now());
  }, []);
  const heard = useCallback(() => watch.current?.heard(Date.now()), []);
  const seconds = useCallback(() => callSeconds(connectedAt.current, Date.now()), []);
  const endedBySilence = useCallback(() => fired.current, []);

  return { connected, heard, seconds, endedBySilence };
}
