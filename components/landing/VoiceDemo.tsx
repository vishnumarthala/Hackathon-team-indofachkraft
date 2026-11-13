"use client";

import { ConversationProvider, useConversation } from "@elevenlabs/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { SAMPLE_CALL, SAMPLE_CALL_SRC, type SampleTurn } from "@/components/landing/sampleCall";
import { useVoiceCallGuard } from "@/components/voice/useVoiceCallGuard";
import { useT } from "@/lib/i18n/client";
import type { TFunction } from "@/lib/i18n/keys";
import { reportVoiceEnd } from "@/lib/voice/client";
import { INTAKE_DEMO_MAX_SECONDS, voiceRefusal } from "@/lib/voice/constants";

export type DemoLanguage = "en" | "hi" | "te";

export const DEMO_LANGUAGES: Array<{ value: DemoLanguage; label: string }> = [
  { value: "en", label: "English" },
  { value: "hi", label: "हिन्दी (Hindi)" },
  { value: "te", label: "తెలుగు (Telugu)" },
];

export const DEMO_CALL_LIMIT_SEC = INTAKE_DEMO_MAX_SECONDS;

// English defaults (also the en catalogue values); the component passes translated messages.
export const DEMO_CONSENT =
  "I understand this is a demo with an AI voice assistant. I will not share real health information.";

export type LiveMessages = Record<
  "mic" | "busy" | "unavailable" | "failed" | "connecting" | "speaking" | "listening" | "ended" | "quota" | "paused" | "notAllowed" | "concurrent" | "silence",
  string
>;

export const LIVE_MESSAGES: LiveMessages = {
  mic: "Microphone access is needed for the live demo. You can listen to the sample call instead.",
  busy: "The live demo is busy. Please listen to the sample call or try again in a few minutes.",
  unavailable: "The live demo is not available right now. Please listen to the sample call.",
  failed: "The demo call could not start. Please listen to the sample call instead.",
  connecting: "Connecting…",
  speaking: "Assistant is speaking",
  listening: "Listening… you are the parent of Ravi",
  ended: "Demo call ended. In the product, this call becomes the pre-session brief below.",
  quota: "You've used today's live demo. Listen to the sample call, or try again tomorrow.",
  paused: "Voice is resting right now. Please listen to the sample call.",
  notAllowed: "The live demo is for clinics and booked demos. Please listen to the sample call.",
  concurrent: "You already have a voice call open. End it first.",
  silence: "We ended the call because it went quiet.",
};

export function liveMessages(t: TFunction<"landing.demo">): LiveMessages {
  return {
    mic: t("mic"),
    busy: t("busy"),
    unavailable: t("unavailable"),
    failed: t("failed"),
    connecting: t("connecting"),
    speaking: t("speaking"),
    listening: t("listening"),
    ended: t("ended"),
    quota: t("quota"),
    paused: t("paused"),
    notAllowed: t("notAllowed"),
    concurrent: t("concurrent"),
    silence: t("silence"),
  };
}

export type LiveStatus = "disconnected" | "connecting" | "connected" | "error";

export function liveStatusText(
  status: LiveStatus,
  isSpeaking: boolean,
  wasConnected: boolean,
  messages: LiveMessages = LIVE_MESSAGES,
): string | null {
  if (status === "connecting") return messages.connecting;
  if (status === "connected") return isSpeaking ? messages.speaking : messages.listening;
  if (wasConnected) return messages.ended;
  return null;
}

export function formatCountdown(remainingSec: number): string {
  const s = Math.max(0, Math.ceil(remainingSec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function activeTurnIndex(turns: SampleTurn[], time: number): number {
  for (let i = turns.length - 1; i >= 0; i--) if (time >= turns[i].start) return i;
  return -1;
}

type SessionTarget = { conversationToken: string } | { agentId: string; connectionType: "webrtc" };
export type DemoSessionOptions = SessionTarget & {
  dynamicVariables: Record<string, string>;
  overrides: { agent: { language: DemoLanguage } };
};

export type DemoStartDeps = {
  fetchFn: typeof fetch;
  getMicrophone: () => Promise<{ getTracks?: () => Array<{ stop: () => void }> }>;
  startSession: (options: DemoSessionOptions) => void;
};

export type DemoStartResult = { kind: "started"; usageId: string | null } | { kind: "error"; message: string };

// Microphone first (so the permission prompt comes before any credit is spent), then the server start.
export async function startVoiceDemo(
  language: DemoLanguage,
  deps: DemoStartDeps,
  messages: LiveMessages = LIVE_MESSAGES,
): Promise<DemoStartResult> {
  try {
    const stream = await deps.getMicrophone();
    stream.getTracks?.().forEach((t) => t.stop());
  } catch {
    return { kind: "error", message: messages.mic };
  }

  let res: Response;
  try {
    res = await deps.fetchFn("/api/demo/voice-token", { method: "POST" });
  } catch {
    return { kind: "error", message: messages.failed };
  }
  // 051: cost-guard refusals (quota, budget, one call at a time, not a provider or demo lead) have their own message.
  const refusal = res.ok ? null : voiceRefusal(res.status, await res.clone().json().catch(() => null));
  if (refusal === "quotaDay" || refusal === "quotaMonth") return { kind: "error", message: messages.quota };
  if (refusal === "paused") return { kind: "error", message: messages.paused };
  if (refusal === "concurrent") return { kind: "error", message: messages.concurrent };
  if (refusal === "notAllowed" || refusal === "signIn") return { kind: "error", message: messages.notAllowed };
  if (res.status === 429) return { kind: "error", message: messages.busy };
  if (res.status === 503) return { kind: "error", message: messages.unavailable };
  if (!res.ok) return { kind: "error", message: messages.failed };

  const body = (await res.json().catch(() => ({}))) as {
    conversation_token?: string | null;
    agent_id?: string;
    dynamic_variables?: Record<string, string>;
    voice_usage_id?: string;
  };
  const target: SessionTarget | null = body.conversation_token
    ? { conversationToken: body.conversation_token }
    : body.agent_id
      ? { agentId: body.agent_id, connectionType: "webrtc" }
      : null;
  if (!target) {
    await reportVoiceEnd(deps.fetchFn, body.voice_usage_id, 0);
    return { kind: "error", message: messages.failed };
  }

  try {
    deps.startSession({ ...target, dynamicVariables: body.dynamic_variables ?? {}, overrides: { agent: { language } } });
  } catch {
    // The call never started: close the reservation (FR-7).
    await reportVoiceEnd(deps.fetchFn, body.voice_usage_id, 0);
    return { kind: "error", message: messages.failed };
  }
  return { kind: "started", usageId: body.voice_usage_id ?? null };
}

export type Line = { key: string; role: "agent" | "parent"; text: string };

export const DEMO_CALL_ENDED_EVENT = "carethread:demo-call-ended";

// The agent's voice uses expressive tags such as [warmly]; they are not meant to be read.
export function cleanAgentText(text: string): string {
  return text.replace(/\[[a-z][a-z ]{0,30}\]\s*/gi, "").replace(/\s{2,}/g, " ").trim();
}

// A parent transcript and the agent's reply to it share one event_id, so the key includes the role.
// A repeated key (a corrected agent response) replaces the earlier line.
export function upsertLine(lines: Line[], role: "user" | "agent", eventId: number, message: string): Line[] {
  const speaker = role === "agent" ? "agent" : "parent";
  const text = speaker === "agent" ? cleanAgentText(message) : message.trim();
  if (!text) return lines;
  const key = `${speaker}-${eventId}`;
  const index = lines.findIndex((l) => l.key === key);
  if (index === -1) return [...lines, { key, role: speaker, text }];
  return lines.map((l, i) => (i === index ? { ...l, text } : l));
}

function TranscriptLine({ role, text, active = false }: { role: "agent" | "parent"; text: string; active?: boolean }) {
  const t = useT("landing.demo");
  const agent = role === "agent";
  return (
    <li
      className={`rounded-xl px-3 py-2 text-sm leading-relaxed transition-colors duration-300 ${
        agent ? "bg-teal-50 text-slate-800" : "ml-6 bg-slate-100 text-slate-700"
      } ${active ? "ring-2 ring-teal-500" : ""}`}
    >
      <span className={`mr-1.5 text-xs font-semibold uppercase tracking-wide ${agent ? "text-teal-700" : "text-slate-500"}`}>
        {agent ? t("speakerAi") : t("speakerParent")}
      </span>
      {text}
    </li>
  );
}

function SamplePlayer() {
  const t = useT("landing.demo");
  const audioRef = useRef<HTMLAudioElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const [active, setActive] = useState(-1);

  useEffect(() => {
    if (active < 0) return;
    const item = listRef.current?.children[active] as HTMLElement | undefined;
    const list = listRef.current;
    if (item && list) list.scrollTo({ top: item.offsetTop - list.offsetTop - 8, behavior: "smooth" });
  }, [active]);

  return (
    <div>
      <p className="mb-3 text-sm text-slate-600">{t("sampleIntro")}</p>
      <audio
        ref={audioRef}
        controls
        preload="metadata"
        src={SAMPLE_CALL_SRC}
        onTimeUpdate={(e) => setActive(activeTurnIndex(SAMPLE_CALL, e.currentTarget.currentTime))}
        className="mb-4 w-full"
      >
        <track kind="captions" />
      </audio>
      <ol ref={listRef} aria-label={t("sampleTranscript")} className="max-h-80 space-y-2 overflow-y-auto pr-1">
        {SAMPLE_CALL.map((t, i) => (
          <TranscriptLine key={i} role={t.role} text={t.text} active={i === active} />
        ))}
      </ol>
    </div>
  );
}

function LivePanel() {
  const t = useT("landing.demo");
  const messages = useMemo(() => liveMessages(t), [t]);
  const [language, setLanguage] = useState<DemoLanguage>("en");
  const [consent, setConsent] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [wasConnected, setWasConnected] = useState(false);
  const [remaining, setRemaining] = useState(DEMO_CALL_LIMIT_SEC);
  const connectedRef = useRef(false);
  const usageRef = useRef<string | null>(null);
  const conversationIdRef = useRef<string | null>(null);

  const conversation = useConversation({
    onConnect: ({ conversationId }) => {
      connectedRef.current = true;
      conversationIdRef.current = conversationId || null;
      guard.connected();
      setWasConnected(true);
      setRemaining(DEMO_CALL_LIMIT_SEC);
    },
    onMessage: ({ message, role, event_id }) => {
      if (role === "user" && message?.trim()) guard.heard();
      setLines((prev) => upsertLine(prev, role, event_id, message ?? ""));
    },
    onDisconnect: () => {
      // 051 FR-7: report the connected seconds (a call that never connected reports 0).
      const usageId = usageRef.current;
      usageRef.current = null;
      void reportVoiceEnd(fetch, usageId, guard.seconds(), conversationIdRef.current);
      if (guard.endedBySilence()) setError(messages.silence);
      if (!connectedRef.current) return;
      connectedRef.current = false;
      window.dispatchEvent(new Event(DEMO_CALL_ENDED_EVENT));
    },
    onError: () => {
      setError(messages.failed);
      setStarting(false);
    },
  });
  const status = conversation.status as LiveStatus;
  const live = status === "connecting" || status === "connected";
  const { endSession } = conversation;
  // 051 FR-6: 30 seconds without speech from the visitor ends the call.
  const guard = useVoiceCallGuard({ live: status === "connected", isSpeaking: conversation.isSpeaking, onSilence: () => endSession() });

  useEffect(() => {
    if (status !== "connected") return;
    const timer = setInterval(() => setRemaining((r) => r - 1), 1000);
    return () => clearInterval(timer);
  }, [status]);

  useEffect(() => {
    if (status === "connected" && remaining <= 0) endSession();
  }, [remaining, status, endSession]);

  async function onStart() {
    setError(null);
    setLines([]);
    setWasConnected(false);
    setStarting(true);
    const result = await startVoiceDemo(language, {
      fetchFn: (input, init) => fetch(input, init),
      getMicrophone: () => navigator.mediaDevices.getUserMedia({ audio: true }),
      startSession: (options) => conversation.startSession(options),
    }, messages);
    if (result.kind === "error") setError(result.message);
    else usageRef.current = result.usageId;
    setStarting(false);
  }

  const text = liveStatusText(status, conversation.isSpeaking, wasConnected, messages);

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600">{t("liveIntro", { minutes: DEMO_CALL_LIMIT_SEC / 60 })}</p>
      <div>
        <label htmlFor="demo-language" className="mb-1 block text-sm font-semibold text-slate-800">
          {t("language")}
        </label>
        <select
          id="demo-language"
          value={language}
          disabled={live}
          onChange={(e) => setLanguage(e.target.value as DemoLanguage)}
          className="min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-base"
        >
          {DEMO_LANGUAGES.map((l) => (
            <option key={l.value} value={l.value}>
              {l.label}
            </option>
          ))}
        </select>
      </div>
      <label className="flex items-start gap-3 text-sm text-slate-700">
        <input
          type="checkbox"
          checked={consent}
          disabled={live}
          onChange={(e) => setConsent(e.target.checked)}
          className="mt-0.5 h-5 w-5 shrink-0 accent-teal-700"
        />
        <span>{t("consent")}</span>
      </label>

      {status === "connected" ? (
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => endSession()}
            className="lp-press min-h-12 rounded-full bg-rose-700 px-6 py-3 font-semibold text-white hover:bg-rose-800"
          >
            {t("end")}
          </button>
          <span className="text-sm tabular-nums text-slate-600" aria-label={t("timeLeftLabel")}>
            {t("timeLeft", { time: formatCountdown(remaining) })}
          </span>
        </div>
      ) : (
        <button
          type="button"
          onClick={onStart}
          disabled={!consent || starting || status === "connecting"}
          className="lp-press min-h-12 w-full rounded-full bg-teal-700 px-6 py-3 font-semibold text-white shadow-lg shadow-teal-700/25 hover:bg-teal-800 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
        >
          {t("start")}
        </button>
      )}

      {text && !error && (
        <p role="status" className="flex items-center gap-2 text-sm font-medium text-slate-900">
          {status === "connected" && <span className="lp-pulse h-2.5 w-2.5 rounded-full bg-teal-500" />}
          {text}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-rose-700">
          {error}
        </p>
      )}
      {lines.length > 0 && (
        <ol aria-label={t("liveTranscript")} className="max-h-72 space-y-2 overflow-y-auto pr-1">
          {lines.map((l) => (
            <TranscriptLine key={l.key} role={l.role} text={l.text} />
          ))}
        </ol>
      )}
    </div>
  );
}

// 051 FR-2: `liveAllowed` (server-side: provider / platform admin account, or a demo lead signed in with the verified
// email) adds the live tab. Everyone else gets only the recorded sample: no /api/demo/voice-token request at all.
export function VoiceDemo({ liveAllowed = false }: { liveAllowed?: boolean }) {
  const t = useT("landing.demo");
  const [tab, setTab] = useState<"sample" | "live">("sample");
  const tabClass = (t: typeof tab) =>
    `min-h-11 flex-1 rounded-full px-4 py-2 text-sm font-semibold transition-colors ${
      tab === t ? "bg-white text-teal-800 shadow" : "text-slate-600 hover:text-slate-900"
    }`;
  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-xl shadow-slate-900/5 sm:p-6">
      {liveAllowed ? (
        <div role="tablist" aria-label={t("tabsLabel")} className="mb-5 flex gap-1 rounded-full bg-slate-100 p-1">
          <button type="button" role="tab" aria-selected={tab === "sample"} onClick={() => setTab("sample")} className={tabClass("sample")}>
            {t("sampleTab")}
          </button>
          <button type="button" role="tab" aria-selected={tab === "live"} onClick={() => setTab("live")} className={tabClass("live")}>
            {t("liveTab")}
          </button>
        </div>
      ) : (
        <h3 className="mb-4 text-base font-semibold text-slate-900">{t("sampleTab")}</h3>
      )}
      <div role={liveAllowed ? "tabpanel" : undefined}>
        {tab === "sample" || !liveAllowed ? (
          <SamplePlayer />
        ) : (
          <ConversationProvider>
            <LivePanel />
          </ConversationProvider>
        )}
      </div>
      {liveAllowed ? null : <p className="mt-4 text-xs text-slate-500">{t("liveOnly")}</p>}
    </div>
  );
}
