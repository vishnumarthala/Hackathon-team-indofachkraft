"use client";

import { ConversationProvider, useConversation } from "@elevenlabs/react";
import { useState } from "react";
import type { Language } from "@/lib/types";

export const MESSAGES = {
  demo: "Demo mode: no live call.",
  mic: "Microphone access is needed for the call. Please allow it and try again.",
  failed: "The call failed. Please try again.",
  connecting: "Connecting…",
  connected: "Connected - speak now",
  ended: "Call ended. Thank you! You can close this page.",
  startFailed: "Could not start the call",
} as const;

export const LANGUAGE_OPTIONS: Array<{ value: Language; label: string }> = [
  { value: "en", label: "English" },
  { value: "hi", label: "हिन्दी (Hindi)" },
  { value: "te", label: "తెలుగు (Telugu)" },
];

export const CONSENT_LABEL =
  "I agree to talk to an AI assistant and for this call to be recorded and summarised for the therapist.";

export type SdkStatus = "disconnected" | "connecting" | "connected" | "error";

export function statusText(status: SdkStatus, wasConnected: boolean): string | null {
  if (status === "connecting") return MESSAGES.connecting;
  if (status === "connected") return MESSAGES.connected;
  if (status === "disconnected" && wasConnected) return MESSAGES.ended;
  return null;
}

type SessionOptions = {
  conversationToken: string;
  dynamicVariables: Record<string, string>;
  overrides: { agent: { language: Language } };
  onError: () => void;
};

export type StartDeps = {
  fetchFn: typeof fetch;
  getMicrophone: () => Promise<{ getTracks?: () => Array<{ stop: () => void }> }>;
  startSession: (options: SessionOptions) => void;
  onSdkError: () => void;
};

export type StartResult = { kind: "demo" } | { kind: "error"; message: string } | { kind: "started" };

// The whole start flow, free of React so it can be tested with mocks.
export async function startIntakeCall(token: string, language: Language, deps: StartDeps): Promise<StartResult> {
  let res: Response;
  try {
    res = await deps.fetchFn(`/api/intake/${encodeURIComponent(token)}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ language }),
    });
  } catch {
    return { kind: "error", message: MESSAGES.startFailed };
  }
  const body = (await res.json().catch(() => ({}))) as {
    demo?: boolean;
    error?: string;
    conversation_token?: string;
    dynamic_variables?: Record<string, string>;
  };
  if (!res.ok) return { kind: "error", message: body.error ?? MESSAGES.startFailed };
  if (body.demo === true) return { kind: "demo" };
  if (!body.conversation_token) return { kind: "error", message: MESSAGES.startFailed };

  try {
    const stream = await deps.getMicrophone();
    // Only needed for the permission prompt; the SDK opens its own stream.
    stream.getTracks?.().forEach((t) => t.stop());
  } catch {
    return { kind: "error", message: MESSAGES.mic };
  }

  try {
    deps.startSession({
      conversationToken: body.conversation_token,
      dynamicVariables: body.dynamic_variables ?? {},
      overrides: { agent: { language } },
      onError: deps.onSdkError,
    });
  } catch {
    return { kind: "error", message: MESSAGES.failed };
  }
  return { kind: "started" };
}

export type IntakeCallProps = { token: string; childAlias: string; defaultLanguage: Language };

export function IntakeCall(props: IntakeCallProps) {
  return (
    <ConversationProvider>
      <IntakeCallInner {...props} />
    </ConversationProvider>
  );
}

function IntakeCallInner({ token, childAlias, defaultLanguage }: IntakeCallProps) {
  const [language, setLanguage] = useState<Language>(defaultLanguage);
  const [consent, setConsent] = useState(false);
  const [starting, setStarting] = useState(false);
  const [demo, setDemo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wasConnected, setWasConnected] = useState(false);

  const conversation = useConversation({
    onConnect: () => setWasConnected(true),
  });
  const status = conversation.status as SdkStatus;
  const live = status === "connecting" || status === "connected";
  const ended = status === "disconnected" && wasConnected;

  async function onStart() {
    setError(null);
    setStarting(true);
    setWasConnected(false);
    const result = await startIntakeCall(token, language, {
      fetchFn: (input, init) => fetch(input, init),
      getMicrophone: () => navigator.mediaDevices.getUserMedia({ audio: true }),
      startSession: (options) => conversation.startSession(options),
      onSdkError: () => {
        setError(MESSAGES.failed);
        setWasConnected(false);
        setStarting(false);
      },
    });
    if (result.kind === "demo") setDemo(true);
    if (result.kind === "error") setError(result.message);
    setStarting(false);
  }

  const text = statusText(status, wasConnected);

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-semibold break-words">Intake call for {childAlias}&apos;s family</h1>
      <p className="text-base text-slate-800">
        You will talk to an AI assistant, not a person. It asks about {childAlias}&apos;s development so the therapist
        is prepared. The call takes up to 15 minutes and is recorded and summarised for the therapist.
      </p>

      <div>
        <label htmlFor="intake-language" className="block text-sm font-medium text-slate-800">
          Language
        </label>
        <select
          id="intake-language"
          value={language}
          disabled={live}
          onChange={(e) => setLanguage(e.target.value as Language)}
          className="mt-1 min-h-11 w-full rounded border border-slate-300 bg-white px-3 py-2 text-base"
        >
          {LANGUAGE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      <label className="flex items-start gap-3 text-base text-slate-800">
        <input
          type="checkbox"
          checked={consent}
          disabled={live}
          onChange={(e) => setConsent(e.target.checked)}
          className="mt-1 h-5 w-5 shrink-0"
        />
        <span>{CONSENT_LABEL}</span>
      </label>

      {!live && !ended && !demo && (
        <button
          type="button"
          onClick={onStart}
          disabled={!consent || starting}
          className="min-h-12 w-full rounded bg-slate-900 px-4 py-3 text-base font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          Start call
        </button>
      )}

      {status === "connected" && (
        <button
          type="button"
          onClick={() => conversation.endSession()}
          className="min-h-12 w-full rounded bg-red-700 px-4 py-3 text-base font-semibold text-white"
        >
          End call
        </button>
      )}

      {text && !error && (
        <p role="status" className="text-base font-medium text-slate-900">
          {text}
        </p>
      )}

      {demo && (
        <div>
          <p role="status" className="text-base font-medium text-slate-900">
            {MESSAGES.demo}
          </p>
          <div id="demo-actions"></div>
        </div>
      )}

      {error && (
        <p role="alert" className="text-base text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
