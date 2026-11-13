"use client";

import { ConversationProvider, useConversation } from "@elevenlabs/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { SimulateCallButton } from "@/components/intake/SimulateCallButton";
import { CallLanguageNote, VoiceLanguageChoice } from "@/components/voice/VoiceLanguageChoice";
import { LANGUAGE_UNAVAILABLE, planVoiceLanguage, voiceOverrides } from "@/lib/agents/languages";
import { useLocale, useT } from "@/lib/i18n/client";
import type { Locale } from "@/lib/i18n/config";
import type { TFunction } from "@/lib/i18n/keys";
import type { Language } from "@/lib/types";

export type IntakeMessages = Record<
  | "demo"
  | "mic"
  | "failed"
  | "connecting"
  | "connected"
  | "ended"
  | "startFailed"
  | "notFound"
  | "alreadyComplete"
  | "saving"
  | "saveFailed"
  | "saveTimeout"
  | "retry",
  string
>;

// English defaults (equal to the en catalogue); the component passes the viewer's translations.
export const MESSAGES: IntakeMessages = {
  demo: "Demo mode: no live call.",
  mic: "Microphone access is needed for the call. Please allow it and try again.",
  failed: "The call failed. Please try again.",
  connecting: "Connecting…",
  connected: "Connected - speak now",
  ended: "Call ended. Thank you! You can close this page.",
  startFailed: "Could not start the call",
  notFound: "This link is not valid.",
  alreadyComplete: "This intake call is already complete",
  saving: "Saving your answers… Please keep this page open.",
  saveFailed: "We could not save your call yet. Please check your internet connection and select Try again.",
  saveTimeout: "Saving your call is taking longer than expected. Please wait a minute and select Try again.",
  retry: "Try again",
};

export function intakeMessages(t: TFunction<"intake.status">): IntakeMessages {
  return {
    demo: t("demo"),
    mic: t("mic"),
    failed: t("failed"),
    connecting: t("connecting"),
    connected: t("connected"),
    ended: t("ended"),
    startFailed: t("startFailed"),
    notFound: t("notFound"),
    alreadyComplete: t("alreadyComplete"),
    saving: t("saving"),
    saveFailed: t("saveFailed"),
    saveTimeout: t("saveTimeout"),
    retry: t("retry"),
  };
}

export const LANGUAGE_OPTIONS: Array<{ value: Language; label: string }> = [
  { value: "en", label: "English" },
  { value: "hi", label: "हिन्दी (Hindi)" },
  { value: "te", label: "తెలుగు (Telugu)" },
];

// English default (equal to the en catalogue value intake.consent).
export const CONSENT_LABEL =
  "I agree to talk to an AI assistant and for this call to be recorded and summarised for the therapist.";

export type SdkStatus = "disconnected" | "connecting" | "connected" | "error";

export function statusText(status: SdkStatus, wasConnected: boolean, messages: IntakeMessages = MESSAGES): string | null {
  if (status === "connecting") return messages.connecting;
  if (status === "connected") return messages.connected;
  if (status === "disconnected" && wasConnected) return messages.ended;
  return null;
}

// Private agent: server-issued conversation token. Public agent: started by its ID (no token available).
type SessionTarget = { conversationToken: string } | { agentId: string; connectionType: "webrtc" };

type SessionOptions = SessionTarget & {
  dynamicVariables: Record<string, string>;
  overrides?: { agent: { language: Language } };
  onError: () => void;
};

/**
 * 035: the appointment intake (`/intake/a/<token>`) uses its own API base. 049: the generic agent gets the language
 * override only for Hindi and Telugu (`overrideLanguage: "non-english"`; English uses its base configuration).
 */
export type IntakeApiOptions = { apiBase?: string; overrideLanguage?: boolean | "non-english" };

export function intakeApiBase(token: string, opts: IntakeApiOptions = {}): string {
  return opts.apiBase ?? `/api/intake/${encodeURIComponent(token)}`;
}

export type StartDeps = {
  fetchFn: typeof fetch;
  getMicrophone: () => Promise<{ getTracks?: () => Array<{ stop: () => void }> }>;
  startSession: (options: SessionOptions) => void;
  onSdkError: () => void;
};

/** 049: `languageUnavailable` = the generic agent does not speak the requested language (409). */
export type StartResult = { kind: "demo" } | { kind: "error"; message: string } | { kind: "started" } | { kind: "languageUnavailable" };

// The whole start flow, free of React so it can be tested with mocks.
export async function startIntakeCall(
  token: string,
  language: Language,
  deps: StartDeps,
  messages: IntakeMessages = MESSAGES,
  opts: IntakeApiOptions = {},
): Promise<StartResult> {
  let res: Response;
  try {
    res = await deps.fetchFn(`${intakeApiBase(token, opts)}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ language }),
    });
  } catch {
    return { kind: "error", message: messages.startFailed };
  }
  const body = (await res.json().catch(() => ({}))) as {
    demo?: boolean;
    conversation_token?: string | null;
    agent_id?: string;
    dynamic_variables?: Record<string, string>;
  };
  if (!res.ok) {
    if (res.status === 409 && (body as { error?: string }).error === LANGUAGE_UNAVAILABLE) return { kind: "languageUnavailable" };
    // The API answers in English; show its known answers in the viewer's language.
    if (res.status === 404) return { kind: "error", message: messages.notFound };
    if (res.status === 409) return { kind: "error", message: messages.alreadyComplete };
    return { kind: "error", message: messages.startFailed };
  }
  if (body.demo === true) return { kind: "demo" };
  const target: SessionTarget | null = body.conversation_token
    ? { conversationToken: body.conversation_token }
    : body.agent_id
      ? { agentId: body.agent_id, connectionType: "webrtc" }
      : null;
  if (!target) return { kind: "error", message: messages.startFailed };

  try {
    const stream = await deps.getMicrophone();
    // Only needed for the permission prompt; the SDK opens its own stream.
    stream.getTracks?.().forEach((t) => t.stop());
  } catch {
    return { kind: "error", message: messages.mic };
  }

  try {
    deps.startSession({
      ...target,
      dynamicVariables: body.dynamic_variables ?? {},
      ...(opts.overrideLanguage === false
        ? {}
        : opts.overrideLanguage === "non-english"
          ? voiceOverrides(language)
          : { overrides: { agent: { language } } }),
      onError: deps.onSdkError,
    });
  } catch {
    return { kind: "error", message: messages.failed };
  }
  return { kind: "started" };
}

export const COMPLETION_POLL_MS = 3_000;
export const COMPLETION_TIMEOUT_MS = 120_000;

export type CompletionState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "done" }
  | { kind: "error"; message: string };

export type CompletionPoller = { start: () => boolean; cancel: () => void };

// FR-12: posts the conversation id to the completion endpoint, re-polls every 3 s on 202 for at most
// 120 s, never overlaps requests, and can be restarted after an error without a second call.
export function createCompletionPoller(
  token: string,
  conversationId: string,
  fetchFn: (input: string, init?: RequestInit) => Promise<Response>,
  onState: (state: CompletionState) => void,
  messages: IntakeMessages = MESSAGES,
  opts: IntakeApiOptions = {},
): CompletionPoller {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;
  let cancelled = false;
  let deadline = 0;
  let run = 0;
  const url = `${intakeApiBase(token, opts)}/complete`;

  const current = (id: number) => !cancelled && id === run;

  async function attempt(id: number): Promise<void> {
    timer = null;
    inFlight = true;
    try {
      let res: Response;
      try {
        res = await fetchFn(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ conversation_id: conversationId }),
        });
      } catch {
        if (current(id)) onState({ kind: "error", message: messages.saveFailed });
        return;
      }
      if (!current(id)) return;
      if (res.status === 202) {
        if (Date.now() >= deadline) onState({ kind: "error", message: messages.saveTimeout });
        else timer = setTimeout(() => void attempt(id), COMPLETION_POLL_MS);
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { received?: boolean; ignored?: string };
      if (!current(id)) return;
      if (res.ok && body.received === true && !body.ignored) onState({ kind: "done" });
      else onState({ kind: "error", message: messages.saveFailed });
    } finally {
      inFlight = false;
    }
  }

  return {
    start() {
      if (cancelled || inFlight || timer !== null) return false;
      run += 1;
      deadline = Date.now() + COMPLETION_TIMEOUT_MS;
      onState({ kind: "saving" });
      void attempt(run);
      return true;
    },
    cancel() {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}

export function completionText(state: CompletionState, messages: IntakeMessages = MESSAGES): string | null {
  if (state.kind === "saving") return messages.saving;
  if (state.kind === "done") return messages.ended;
  if (state.kind === "error") return state.message;
  return null;
}

/** `defaultLanguage` is the case's call language; without one the call language follows the UI locale. */
export type IntakeCallProps = {
  token: string;
  childAlias: string;
  defaultLanguage: Language | null;
  /** 035 appointment intake: API base, simulator path, no language choice for the English-only generic agent. */
  apiBase?: string;
  simulatePath?: string;
  languageSelect?: boolean;
  /** Server-translated copy replacing the Child Development title / intro / consent label. */
  copy?: { title: string; intro: string; consent: string };
  /**
   * 049: the generic agent (no language choice) speaks the page language when it is enabled (`voiceLanguages`,
   * ELEVENLABS_GENERIC_INTAKE_LANGUAGES); otherwise the page offers "Voice in English" or skipping the call.
   */
  voiceLanguages?: Locale[];
  providerName?: string;
};

export function IntakeCall(props: IntakeCallProps) {
  return (
    <ConversationProvider>
      <IntakeCallInner {...props} />
    </ConversationProvider>
  );
}

function IntakeCallInner({
  token,
  childAlias,
  defaultLanguage,
  apiBase,
  simulatePath,
  languageSelect = true,
  copy,
  voiceLanguages = ["en"],
  providerName = "",
}: IntakeCallProps) {
  const t = useT("intake");
  const tStatus = useT("intake.status");
  const tf = useT("voiceAgents.fallback");
  const messages = useMemo(() => intakeMessages(tStatus), [tStatus]);
  const uiLocale = useLocale();
  // 049: without a language choice (generic agent) the call speaks the page language when the agent has it.
  const [languageRefused, setLanguageRefused] = useState(false);
  const plan = languageRefused ? ({ kind: "fallback", language: "en", locale: uiLocale } as const) : planVoiceLanguage(uiLocale, voiceLanguages);
  const [englishChosen, setEnglishChosen] = useState(false);
  const [skipped, setSkipped] = useState(false);
  // The call language is independent of the UI language: switching the UI never changes it.
  const [chosenLanguage, setLanguage] = useState<Language>(defaultLanguage ?? uiLocale);
  const language: Language = languageSelect ? chosenLanguage : plan.language;
  const choosing = !languageSelect && plan.kind === "fallback" && !englishChosen;
  const apiOptions = useMemo<IntakeApiOptions>(
    () => ({ apiBase, overrideLanguage: languageSelect ? true : "non-english" }),
    [apiBase, languageSelect],
  );
  const [consent, setConsent] = useState(false);
  const [starting, setStarting] = useState(false);
  const [demo, setDemo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wasConnected, setWasConnected] = useState(false);
  const [completion, setCompletion] = useState<CompletionState>({ kind: "idle" });
  const conversationIdRef = useRef<string | null>(null);
  const connectedRef = useRef(false);
  const pollerRef = useRef<CompletionPoller | null>(null);

  useEffect(() => () => pollerRef.current?.cancel(), []);

  function startCompletion() {
    const conversationId = conversationIdRef.current;
    if (!conversationId) {
      setCompletion({ kind: "error", message: messages.saveFailed });
      return;
    }
    pollerRef.current ??= createCompletionPoller(token, conversationId, (i, init) => fetch(i, init), setCompletion, messages, apiOptions);
    pollerRef.current.start();
  }

  const conversation = useConversation({
    onConnect: ({ conversationId }: { conversationId?: string } = {}) => {
      if (conversationId) conversationIdRef.current = conversationId;
      connectedRef.current = true;
      setWasConnected(true);
    },
    onDisconnect: () => {
      if (!connectedRef.current) return;
      connectedRef.current = false;
      if (!conversationIdRef.current) {
        try {
          conversationIdRef.current = conversation.getId() || null;
        } catch {
          // No id available; startCompletion shows the error.
        }
      }
      startCompletion();
    },
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
        connectedRef.current = false;
        setError(messages.failed);
        setWasConnected(false);
        setStarting(false);
      },
    }, messages, apiOptions);
    if (result.kind === "languageUnavailable") setLanguageRefused(true);
    if (result.kind === "demo") setDemo(true);
    if (result.kind === "error") setError(result.message);
    setStarting(false);
  }

  // After a connected call ends, the completion state (not the SDK status) says whether it was saved.
  const text = ended ? completionText(completion, messages) : statusText(status, wasConnected, messages);

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-semibold break-words">{copy?.title ?? t("title", { child: childAlias })}</h1>
      <p className="text-base text-slate-800">{copy?.intro ?? t("intro", { child: childAlias })}</p>

      {languageSelect && (
        <div>
          <label htmlFor="intake-language" className="block text-sm font-medium text-slate-800">
            {t("callLanguage")}
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
      )}

      {!languageSelect && plan.kind === "native" ? <CallLanguageNote className="text-base text-slate-800" /> : null}

      {skipped ? (
        <p role="status" className="text-base font-medium text-slate-900" data-testid="intake-skipped">
          {tf("skipped", { provider: providerName })}
        </p>
      ) : null}

      {choosing && !skipped ? (
        <VoiceLanguageChoice
          message={tf("intakeMessage", { provider: providerName })}
          onVoiceInEnglish={() => setEnglishChosen(true)}
          alternative={{ label: tf("skipCall"), onClick: () => setSkipped(true) }}
        />
      ) : null}

      {choosing || skipped ? null : (
        <label className="flex items-start gap-3 text-base text-slate-800">
          <input
            type="checkbox"
            checked={consent}
            disabled={live}
            onChange={(e) => setConsent(e.target.checked)}
            className="mt-1 h-5 w-5 shrink-0"
          />
          <span>{copy?.consent ?? t("consent")}</span>
        </label>
      )}

      {!live && !ended && !demo && !choosing && !skipped && (
        <button
          type="button"
          onClick={onStart}
          disabled={!consent || starting}
          className="min-h-12 w-full rounded bg-slate-900 px-4 py-3 text-base font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t("start")}
        </button>
      )}

      {status === "connected" && (
        <button
          type="button"
          onClick={() => conversation.endSession()}
          className="min-h-12 w-full rounded bg-red-700 px-4 py-3 text-base font-semibold text-white"
        >
          {t("end")}
        </button>
      )}

      {text && !error && completion.kind !== "error" && (
        <p role="status" className="text-base font-medium text-slate-900">
          {text}
        </p>
      )}

      {ended && completion.kind === "error" && (
        <div className="space-y-3">
          <p role="alert" className="text-base text-red-700">
            {completion.message}
          </p>
          <button
            type="button"
            onClick={startCompletion}
            className="min-h-12 w-full rounded bg-slate-900 px-4 py-3 text-base font-semibold text-white"
          >
            {messages.retry}
          </button>
        </div>
      )}

      {demo && (
        <div>
          <p role="status" className="text-base font-medium text-slate-900">
            {messages.demo}
          </p>
          <div id="demo-actions">
            <SimulateCallButton token={token} path={simulatePath} language={languageSelect ? undefined : language} />
          </div>
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
