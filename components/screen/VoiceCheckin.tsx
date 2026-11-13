"use client";

import { ConversationProvider, useConversation } from "@elevenlabs/react";
import { useEffect, useRef, useState } from "react";
import { upsertLine, type Line } from "@/components/landing/VoiceDemo";
import { useT } from "@/lib/i18n/client";
import { finishScreen, screenClientTools, type StartedSession } from "@/lib/screen/client";
import { VOICE_MAX_MINUTES, type ScreenResult } from "@/lib/screen/questions";
import { UrgentNotice } from "./UrgentNotice";
import { secondaryButton } from "./view";

type Target = { conversationToken: string } | { agentId: string; connectionType: "webrtc" };

export type VoiceProps = {
  session: StartedSession;
  target: Target;
  dynamicVariables: Record<string, string>;
  /** Red flag: the call has ended; the page keeps showing only the 108/112 message. */
  onStopped: () => void;
  onFinished: (result: ScreenResult) => void;
  /** The call ended before every question was answered: continue with the form, answers kept. */
  onContinueByTapping: (answers: Record<string, string>, failed: boolean) => void;
};

/** Seconds the agent gets to say the safety message / goodbye before the page ends the call itself. */
export const WRAP_UP_SECONDS = 20;
/** A call that has not connected by then falls back to tapping (network or provider failure). */
export const CONNECT_TIMEOUT_SECONDS = 20;

type Phase = "live" | "stopped" | "complete";

function VoicePanel({ session, target, dynamicVariables, onStopped, onFinished, onContinueByTapping }: VoiceProps) {
  const t = useT("screen");
  const [phase, setPhase] = useState<Phase>("live");
  const [answered, setAnswered] = useState(0);
  const [lines, setLines] = useState<Line[]>([]);
  const [finishing, setFinishing] = useState(false);
  const phaseRef = useRef<Phase>("live");
  const answersRef = useRef<Record<string, string>>({});
  const failedRef = useRef(false);
  const endedRef = useRef(false);
  const connectedRef = useRef(false);
  const conversationIdRef = useRef<string | undefined>(undefined);

  async function handleEnd() {
    if (endedRef.current) return;
    endedRef.current = true;
    if (phaseRef.current === "stopped") return onStopped();
    if (phaseRef.current === "complete") {
      setFinishing(true);
      const done = await finishScreen(fetch, session.session_id, conversationIdRef.current);
      if (done.ok) return done.result.red_flag ? onStopped() : onFinished(done.result);
    }
    onContinueByTapping(answersRef.current, failedRef.current);
  }

  const conversation = useConversation({
    onConnect: ({ conversationId }) => {
      connectedRef.current = true;
      conversationIdRef.current = conversationId;
    },
    onMessage: ({ message, role, event_id }) => setLines((prev) => upsertLine(prev, role, event_id, message ?? "")),
    onDisconnect: () => void handleEnd(),
    onError: () => {
      failedRef.current = true;
    },
  });
  const { endSession, startSession } = conversation;
  const status = conversation.status as "disconnected" | "connecting" | "connected" | "error";

  useEffect(() => {
    const tools = screenClientTools(
      session.session_id,
      { fetchFn: (input, init) => fetch(input, init), conversationId: () => conversationIdRef.current },
      {
        onAnswer: (itemId, answer, missing) => {
          answersRef.current = { ...answersRef.current, [itemId]: answer };
          setAnswered(session.questions.length - missing.length);
        },
        onStop: () => {
          phaseRef.current = "stopped";
          setPhase("stopped");
        },
        onComplete: () => {
          if (phaseRef.current !== "live") return;
          phaseRef.current = "complete";
          setPhase("complete");
        },
      },
    );
    try {
      startSession({ ...target, dynamicVariables, clientTools: tools });
    } catch {
      failedRef.current = true;
      void handleEnd();
    }
    // Start exactly once for this session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // NFR-3: a call that cannot connect never blocks the check-in: continue by tapping.
  useEffect(() => {
    const timer = setTimeout(() => {
      if (connectedRef.current) return;
      failedRef.current = true;
      endSession();
      void handleEnd();
    }, CONNECT_TIMEOUT_SECONDS * 1000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // FR-3: the agent itself is capped at 8 minutes; the page enforces the same limit.
  useEffect(() => {
    if (status !== "connected") return;
    const timer = setTimeout(() => endSession(), VOICE_MAX_MINUTES * 60_000);
    return () => clearTimeout(timer);
  }, [status, endSession]);

  // After a red flag or the last answer the agent says its closing line; then the call ends.
  useEffect(() => {
    if (phase === "live") return;
    const timer = setTimeout(() => {
      if (status === "connected" || status === "connecting") endSession();
      else void handleEnd();
    }, WRAP_UP_SECONDS * 1000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  if (phase === "stopped") return <UrgentNotice />;

  const statusText =
    finishing || phase === "complete"
      ? t("voice.finishing")
      : status === "connecting" || status === "disconnected"
        ? t("voice.connecting")
        : conversation.isSpeaking
          ? t("voice.speaking")
          : t("voice.listening");

  return (
    <div className="space-y-4" data-testid="screen-voice">
      <p role="status" className="flex items-center gap-2 font-medium text-slate-900">
        {status === "connected" ? <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full bg-teal-500" /> : null}
        {statusText}
      </p>
      <p className="text-sm text-slate-600">{t("voice.progress", { answered, total: session.questions.length })}</p>
      <div className="flex flex-col gap-3 sm:flex-row">
        <button type="button" className={secondaryButton} onClick={() => endSession()} disabled={status !== "connected"}>
          {t("voice.end")}
        </button>
        <button
          type="button"
          className={secondaryButton}
          onClick={() => {
            if (status === "connected" || status === "connecting") endSession();
            void handleEnd();
          }}
        >
          {t("voice.switchToForm")}
        </button>
      </div>
      {lines.length > 0 ? (
        <ol aria-label={t("voice.transcript")} className="max-h-72 space-y-2 overflow-y-auto pr-1">
          {lines.map((l) => (
            <li
              key={l.key}
              className={`rounded-xl px-3 py-2 text-sm leading-relaxed ${l.role === "agent" ? "bg-teal-50 text-slate-800" : "ml-6 bg-slate-100 text-slate-700"}`}
            >
              <span className="mr-1.5 text-xs font-semibold text-slate-600">
                {l.role === "agent" ? t("voice.speakerAi") : t("voice.speakerYou")}
              </span>
              <span lang="en">{l.text}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

// Ticket 033 FR-3: the English-only voice check-in. The agent asks the same questions as the form and reports each
// answer through the `record_answer` / `record_red_flag` client tools (lib/screen/client.ts).
export function VoiceCheckin(props: VoiceProps) {
  return (
    <ConversationProvider>
      <VoicePanel {...props} />
    </ConversationProvider>
  );
}
