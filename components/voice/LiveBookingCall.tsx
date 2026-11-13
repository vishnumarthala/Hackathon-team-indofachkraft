"use client";

import { ConversationProvider, useConversation } from "@elevenlabs/react";
import { useEffect, useRef } from "react";
import { VOICE_MAX_MINUTES } from "@/lib/agents/booking/constants";
import { voiceOverrides } from "@/lib/agents/languages";
import type { Locale } from "@/lib/i18n/config";
import { useVoiceCallGuard } from "./useVoiceCallGuard";

export type LiveTarget = { conversationToken: string } | { agentId: string; connectionType: "webrtc" };

export type EndedCall = { seconds: number; conversationId: string | null; silence: boolean };

export type LiveCallProps = {
  target: LiveTarget;
  /** 049: the call language (`overrides.agent.language` for Hindi and Telugu). */
  language?: Locale;
  dynamicVariables: Record<string, string>;
  onLine: (role: "user" | "agent", eventId: number, text: string) => void;
  onStatus: (status: "connecting" | "listening" | "speaking") => void;
  /** The agent reported a red flag (client tool `record_red_flag`). */
  onRedFlag: () => void;
  /** 051: `call` carries the connected seconds and the conversation id for the usage report, and whether silence ended it. */
  onEnded: (failed: boolean, call: EndedCall) => void;
  /** Set by the parent to end the call from outside (End call button, red flag). */
  endRef: { current: (() => void) | null };
};

/** A call that has not connected by then falls back to the normal /find search. */
const CONNECT_TIMEOUT_SECONDS = 20;
/** Seconds the agent gets to say the 108/112 message after a red flag before the widget ends the call. */
const RED_FLAG_WRAP_UP_SECONDS = 20;

function LiveCall({ target, language = "en", dynamicVariables, onLine, onStatus, onRedFlag, onEnded, endRef }: LiveCallProps) {
  const connected = useRef(false);
  const failed = useRef(false);
  const ended = useRef(false);
  const conversationId = useRef<string | null>(null);

  const finish = () => {
    if (ended.current) return;
    ended.current = true;
    onEnded(failed.current || !connected.current, {
      seconds: guard.seconds(),
      conversationId: conversationId.current,
      silence: guard.endedBySilence(),
    });
  };

  const conversation = useConversation({
    onConnect: ({ conversationId: id }) => {
      connected.current = true;
      conversationId.current = id || null;
      guard.connected();
    },
    onMessage: ({ message, role, event_id }) => {
      if (role === "user" && message?.trim()) guard.heard();
      onLine(role, event_id, message ?? "");
    },
    onDisconnect: () => finish(),
    onError: () => {
      failed.current = true;
    },
  });
  const { startSession, endSession } = conversation;
  const status = conversation.status as "disconnected" | "connecting" | "connected" | "error";
  // 051 FR-6: 30 seconds without speech from the parent ends the call.
  const guard = useVoiceCallGuard({ live: status === "connected", isSpeaking: conversation.isSpeaking, onSilence: () => endSession() });

  useEffect(() => {
    endRef.current = () => endSession();
    try {
      startSession({
        ...target,
        dynamicVariables,
        ...voiceOverrides(language),
        clientTools: {
          // FR-1 / 033 rule: on a red flag the screen shows only the 108/112 message at once; the agent says it and ends.
          record_red_flag: async () => {
            onRedFlag();
            setTimeout(() => endSession(), RED_FLAG_WRAP_UP_SECONDS * 1000);
            return "Safety stop recorded. Say the fixed safety message now and end the call. Do not book anything.";
          },
        },
      });
    } catch {
      failed.current = true;
      finish();
    }
    const timer = setTimeout(() => {
      if (connected.current) return;
      failed.current = true;
      endSession();
      finish();
    }, CONNECT_TIMEOUT_SECONDS * 1000);
    return () => clearTimeout(timer);
    // Start exactly once for this session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // FR-1: the agent is capped at 4 minutes (051 FR-6, was 6); the widget enforces the same limit.
  useEffect(() => {
    if (status !== "connected") return;
    const timer = setTimeout(() => endSession(), VOICE_MAX_MINUTES * 60_000);
    return () => clearTimeout(timer);
  }, [status, endSession]);

  useEffect(() => {
    onStatus(status === "connected" ? (conversation.isSpeaking ? "speaking" : "listening") : "connecting");
  }, [status, conversation.isSpeaking, onStatus]);

  return null;
}

// Ticket 034: the live ElevenLabs call (loaded only when a parent starts a live voice booking).
export default function LiveBookingCall(props: LiveCallProps) {
  return (
    <ConversationProvider>
      <LiveCall {...props} />
    </ConversationProvider>
  );
}
