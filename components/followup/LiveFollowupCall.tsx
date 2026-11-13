"use client";

import { ConversationProvider, useConversation } from "@elevenlabs/react";
import { useEffect, useRef } from "react";
import { VOICE_MAX_MINUTES } from "@/lib/followup/constants";
import { useVoiceCallGuard } from "@/components/voice/useVoiceCallGuard";

export type LiveTarget = { conversationToken: string } | { agentId: string; connectionType: "webrtc" };

export type LiveFollowupProps = {
  target: LiveTarget;
  dynamicVariables: Record<string, string>;
  onLine: (role: "user" | "agent", eventId: number, text: string) => void;
  onStatus: (status: "connecting" | "listening" | "speaking") => void;
  onConversationId: (id: string) => void;
  /** 051: the connected seconds for the usage report, and whether silence ended the call. */
  onEnded: (failed: boolean, call: { seconds: number; silence: boolean }) => void;
  /** Set by the parent to end the call from outside (End call button). */
  endRef: { current: (() => void) | null };
};

/** A call that has not connected by then falls back to the text chat. */
const CONNECT_TIMEOUT_SECONDS = 20;

function LiveCall({ target, dynamicVariables, onLine, onStatus, onConversationId, onEnded, endRef }: LiveFollowupProps) {
  const connected = useRef(false);
  const failed = useRef(false);
  const ended = useRef(false);

  const finish = () => {
    if (ended.current) return;
    ended.current = true;
    onEnded(failed.current || !connected.current, { seconds: guard.seconds(), silence: guard.endedBySilence() });
  };

  const conversation = useConversation({
    onConnect: ({ conversationId }) => {
      connected.current = true;
      guard.connected();
      if (conversationId) onConversationId(conversationId);
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
  // 051 FR-6: 30 seconds without speech from the guardian ends the call.
  const guard = useVoiceCallGuard({ live: status === "connected", isSpeaking: conversation.isSpeaking, onSilence: () => endSession() });

  useEffect(() => {
    endRef.current = () => endSession();
    try {
      // The agent answers only through its server tool `answer_question` (docs/elevenlabs-followup-agent.md).
      startSession({ ...target, dynamicVariables });
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

  // FR-5: the call is capped at 10 minutes (051 FR-6, was 15); the page ends the call then as well.
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

// Ticket 040 FR-5: the live ElevenLabs call (loaded only when a guardian starts `Ask by voice` outside DEMO_MODE).
export default function LiveFollowupCall(props: LiveFollowupProps) {
  return (
    <ConversationProvider>
      <LiveCall {...props} />
    </ConversationProvider>
  );
}
