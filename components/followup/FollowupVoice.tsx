"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import { upsertLine, type Line } from "@/components/landing/VoiceDemo";
import { primaryButton, secondaryButton } from "@/components/screen/view";
import { useT } from "@/lib/i18n/client";
import type { ChatItem } from "./AnswerCard";
import type { LiveTarget } from "./LiveFollowupCall";

const LiveFollowupCall = dynamic(() => import("./LiveFollowupCall"), { ssr: false });

type Session = {
  followup_session: string;
  conversation_token: string | null;
  agent_id?: string;
  demo?: boolean;
  dynamic_variables: Record<string, string>;
};

type Phase = "idle" | "starting" | "live" | "ended";

type Props = {
  childId: string;
  demo: boolean;
  onAnswer: (item: ChatItem) => void;
  onCallEnded: () => void;
};

function speak(text: string) {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "en-IN";
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
}

// Ticket 040 FR-5: `Ask by voice`. Live: the private English-only ElevenLabs agent `DoctorNearMe Follow-up`, which
// answers only through its server tool `answer_question` (same handler as the text chat, bound to a 15-minute session
// for this guardian and child). DEMO_MODE: no call; the guardian types what they would say, the demo tool route
// answers with the same handler and the browser reads the answer aloud. Any failure leaves the text chat as is.
export function FollowupVoice({ childId, demo, onAnswer, onCallEnded }: Props) {
  const t = useT("followup.voice");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [status, setStatus] = useState<"connecting" | "listening" | "speaking">("connecting");
  const [said, setSaid] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef<(() => void) | null>(null);
  const conversationId = useRef<string | null>(null);
  const seq = useRef(0);

  const endServerSession = useCallback(async (token: string | undefined) => {
    if (!token) return;
    await fetch("/api/agents/followup/session", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ followup_session: token, conversation_id: conversationId.current }),
    }).catch(() => null);
  }, []);

  useEffect(() => () => window.speechSynthesis?.cancel?.(), []);

  async function start() {
    setPhase("starting");
    setError(null);
    setLines([]);
    conversationId.current = null;
    const res = await fetch("/api/agents/followup/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ child_id: childId }),
    }).catch(() => null);
    const json = (await res?.json().catch(() => null)) as Session | null;
    if (!res || res.status !== 201 || !json) {
      setError(t("unavailable"));
      setPhase("idle");
      return;
    }
    setSession(json);
    setPhase("live");
  }

  async function demoSay() {
    const q = said.trim();
    if (!session || q.length < 3) return;
    setBusy(true);
    seq.current += 1;
    const id = seq.current;
    setLines((prev) => upsertLine(prev, "user", id, q));
    const res = await fetch("/api/agents/followup/demo/answer_question", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ followup_session: session.followup_session, question: q }),
    }).catch(() => null);
    const json = (await res?.json().catch(() => null)) as (ChatItem & { error?: string }) | null;
    setBusy(false);
    setSaid("");
    if (!res?.ok || !json) {
      setLines((prev) => upsertLine(prev, "agent", id, res?.status === 401 ? t("ended") : t("unavailable")));
      if (res?.status === 401) setPhase("ended");
      return;
    }
    setLines((prev) => upsertLine(prev, "agent", id, json.answer));
    speak(json.answer);
    onAnswer({ ...json, id: json.id ?? `rf-${Date.now()}`, question: q, channel: "voice", created_at: new Date().toISOString() });
    // FR-3: a red flag ends the session; the 108/112 message stays on screen.
    if (json.safety === "red_flag") setPhase("ended");
  }

  async function end() {
    if (session?.demo) {
      await endServerSession(session.followup_session);
      setPhase("ended");
      return;
    }
    endRef.current?.();
  }

  const onLine = useCallback((role: "user" | "agent", eventId: number, text: string) => setLines((prev) => upsertLine(prev, role, eventId, text)), []);
  const onEnded = useCallback(
    (failed: boolean) => {
      void endServerSession(session?.followup_session).then(onCallEnded);
      setPhase("ended");
      if (failed) setError(t("failed"));
    },
    [endServerSession, onCallEnded, session?.followup_session, t],
  );

  const target: LiveTarget | null =
    session && !session.demo
      ? session.conversation_token
        ? { conversationToken: session.conversation_token }
        : session.agent_id
          ? { agentId: session.agent_id, connectionType: "webrtc" }
          : null
      : null;

  return (
    <section aria-labelledby="followup-voice-title" data-testid="followup-voice" className="space-y-3 rounded-2xl border border-teal-200 bg-teal-50/60 p-4">
      <h2 id="followup-voice-title" className="text-lg font-semibold text-slate-900">
        {demo ? t("demoTitle") : t("title")}
      </h2>
      <p className="text-slate-700">{t("intro")}</p>
      <p className="text-sm text-slate-600">{demo ? t("demoNote") : t("processor")}</p>

      {phase === "idle" || phase === "ended" ? (
        <button type="button" className={secondaryButton} onClick={() => void start()} data-testid="followup-voice-start">
          {t("button")}
        </button>
      ) : null}

      {phase === "live" && session?.demo ? (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            void demoSay();
          }}
        >
          <label htmlFor="followup-voice-said" className="block font-semibold text-slate-900">
            {t("demoLabel")}
          </label>
          <input
            id="followup-voice-said"
            lang="en"
            maxLength={500}
            value={said}
            onChange={(e) => setSaid(e.target.value)}
            className="block w-full rounded-xl border border-slate-300 bg-white p-3 text-base text-slate-900"
          />
          <button type="submit" className={primaryButton} disabled={busy || said.trim().length < 3}>
            {t("demoSay")}
          </button>
        </form>
      ) : null}

      {phase === "live" && target && session ? (
        <>
          <p role="status" className="font-medium text-teal-900">
            {t(status)}
          </p>
          <LiveFollowupCall
            target={target}
            dynamicVariables={session.dynamic_variables}
            onLine={onLine}
            onStatus={setStatus}
            onConversationId={(id) => {
              conversationId.current = id;
            }}
            onEnded={onEnded}
            endRef={endRef}
          />
        </>
      ) : null}

      {phase === "live" ? (
        <button type="button" className={secondaryButton} onClick={() => void end()}>
          {t("end")}
        </button>
      ) : null}

      {lines.length > 0 ? (
        <ol className="space-y-2" aria-live="polite" data-testid="followup-voice-captions">
          {lines.map((line) => (
            <li key={line.key} className={line.role === "agent" ? "text-slate-900" : "text-slate-700"} lang="en">
              <span className="font-semibold">{line.role === "agent" ? t("agent") : t("parent")}: </span>
              {line.text}
            </li>
          ))}
        </ol>
      ) : null}

      {phase === "ended" && !error ? <p className="text-slate-700">{t("ended")}</p> : null}
      {error ? (
        <p role="alert" className="text-red-800">
          {error}
        </p>
      ) : null}
    </section>
  );
}
