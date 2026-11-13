"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { useTurnstile } from "@/components/security/Turnstile";
import { useT } from "@/lib/i18n/client";
import { SESSION_STORAGE_KEY, startScreen, type StartError, type StartedSession } from "@/lib/screen/client";
import { SCREEN_AGE_BANDS, type ScreenAgeBand, type ScreenMode, type ScreenQuestion, type ScreenResult } from "@/lib/screen/questions";
import { voiceSignInHref } from "@/lib/voice/constants";
import type { LocalityOption } from "./NearbyProviders";
import { QuestionForm } from "./QuestionForm";
import { ResultView } from "./ResultView";
import type { SaveViewer } from "./SaveResult";
import { UrgentNotice } from "./UrgentNotice";
import { VoiceCheckin } from "./VoiceCheckin";
import { AGE_BAND_KEYS, primaryButton, secondaryButton } from "./view";

type Notice = "demo" | "mic" | "voiceFailed" | "silence" | null;
type Step =
  | { kind: "intro" }
  | {
      kind: "voice";
      session: StartedSession;
      target: { conversationToken: string } | { agentId: string; connectionType: "webrtc" };
      dynamicVariables: Record<string, string>;
      usageId: string | null;
    }
  | { kind: "form"; sessionId: string; questions: ScreenQuestion[]; answers: Record<string, string>; notice: Notice }
  | { kind: "result"; sessionId: string; result: ScreenResult }
  | { kind: "urgent" };

type SessionView = {
  session_id: string;
  status: "open" | "stopped" | "finished";
  questions: ScreenQuestion[];
  answers: Record<string, string>;
  result: ScreenResult | null;
};

const storage = {
  get: () => {
    try {
      return window.sessionStorage.getItem(SESSION_STORAGE_KEY);
    } catch {
      return null;
    }
  },
  set: (id: string) => {
    try {
      window.sessionStorage.setItem(SESSION_STORAGE_KEY, id);
    } catch {
      // Private mode: the check-in still works, it just cannot be resumed after a reload.
    }
  },
  clear: () => {
    try {
      window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
    } catch {
      // ignore
    }
  },
};

/** 051: refusals after which the voice button stays off for this visit (the tap path is the way on). */
const VOICE_OFF_ERRORS = new Set(["quotaDay", "quotaMonth", "paused"]);
/** 051: cost-guard refusals are a friendly note (the tap path is right above), not an error. */
const GUARD_ERRORS = new Set(["quotaDay", "quotaMonth", "paused", "concurrent", "signIn", "botCheck"]);

// Ticket 033 FR-2: the public check-in. Only the age band and the answers are sent before sign-in (rule 6); the
// browser keeps just the session id (sessionStorage) so the result survives a reload or signing in to save it.
// 051 FR-1: tapping is the primary, anonymous path ("Start free check-in"); voice needs a free sign-in and returns
// here with `?voice=1`. Quota, budget and bot-check refusals keep the tap option on screen.
export function ScreenFlow({
  viewer,
  localities,
  voiceAvailable,
  turnstileSiteKey = null,
  voiceIntent = false,
}: {
  viewer: SaveViewer;
  localities: LocalityOption[];
  voiceAvailable: boolean;
  /** 051 FR-8: Cloudflare Turnstile site key (null = no bot check). */
  turnstileSiteKey?: string | null;
  /** 051: back from signing in to use voice (`/screen?voice=1`). */
  voiceIntent?: boolean;
}) {
  const t = useT("screen");
  const id = useId();
  const [step, setStep] = useState<Step>({ kind: "intro" });
  const [ageBand, setAgeBand] = useState<ScreenAgeBand | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [starting, setStarting] = useState<ScreenMode | null>(null);
  const [error, setError] = useState<StartError | "expired" | null>(null);
  const signedIn = viewer.kind !== "anonymous";
  const turnstile = useTurnstile(signedIn && voiceAvailable ? turnstileSiteKey : null);
  const voiceButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (voiceIntent && signedIn) voiceButton.current?.scrollIntoView({ block: "center" });
  }, [voiceIntent, signedIn]);

  // Resume a check-in of this browser tab (reload, or back from signing in to save the result). Back from signing in
  // to use voice (051, `?voice=1`) starts at the voice step instead.
  useEffect(() => {
    const saved = voiceIntent ? null : storage.get();
    if (!saved) return;
    let cancelled = false;
    void (async () => {
      const res = await fetch(`/api/screen/sessions/${encodeURIComponent(saved)}`).catch(() => null);
      if (cancelled) return;
      if (!res || !res.ok) {
        storage.clear();
        return;
      }
      const view = (await res.json()) as SessionView;
      if (view.status === "stopped") setStep({ kind: "urgent" });
      else if (view.status === "finished" && view.result) setStep({ kind: "result", sessionId: view.session_id, result: view.result });
      else setStep({ kind: "form", sessionId: view.session_id, questions: view.questions, answers: view.answers, notice: null });
    })();
    return () => {
      cancelled = true;
    };
  }, [voiceIntent]);

  async function start(mode: ScreenMode) {
    if (!ageBand || !agreed) return;
    setError(null);
    setStarting(mode);
    const outcome = await startScreen(ageBand, mode, {
      fetchFn: (input, init) => fetch(input, init),
      getMicrophone: () => navigator.mediaDevices.getUserMedia({ audio: true }),
      turnstileToken: turnstile.token,
    });
    if (mode === "voice") turnstile.reset();
    setStarting(null);
    if (outcome.kind === "error") return setError(outcome.error);
    storage.set(outcome.session.session_id);
    const form = (notice: Notice) =>
      setStep({ kind: "form", sessionId: outcome.session.session_id, questions: outcome.session.questions, answers: {}, notice });
    if (outcome.kind === "form") return form(null);
    if (outcome.kind === "demo") return form("demo");
    if (outcome.kind === "micDenied") return form("mic");
    setStep({
      kind: "voice",
      session: outcome.session,
      target: outcome.target,
      dynamicVariables: outcome.dynamicVariables,
      usageId: outcome.usage.id,
    });
  }

  const stop = () => setStep({ kind: "urgent" });
  const showResult = (sessionId: string) => (result: ScreenResult) => setStep({ kind: "result", sessionId, result });
  const expired = () => {
    storage.clear();
    setError("expired");
    setStep({ kind: "intro" });
  };
  const restart = () => {
    storage.clear();
    setError(null);
    setStep({ kind: "intro" });
  };

  if (step.kind === "urgent") return <UrgentNotice />;

  return (
    <div className="space-y-6">
      <header className="space-y-3">
        <h1 className="text-3xl font-bold text-slate-900">{t("title")}</h1>
        {step.kind === "intro" ? <p className="text-lg text-slate-800">{t("intro")}</p> : null}
      </header>

      {step.kind === "intro" ? (
        <form
          className="space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            void start("form");
          }}
        >
          <p className="rounded-2xl bg-teal-50 p-4 text-slate-800">{t("aiDisclosure")}</p>
          <p className="text-sm text-slate-700">{t("noPersonal")}</p>
          <fieldset className="space-y-2">
            <legend className="mb-1 text-base font-semibold text-slate-900">{t("ageLabel")}</legend>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {SCREEN_AGE_BANDS.map((band) => (
                <label
                  key={band}
                  className={`flex min-h-12 cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 ${
                    ageBand === band ? "border-teal-700 bg-teal-50 font-semibold text-teal-900" : "border-slate-300 text-slate-800"
                  }`}
                >
                  <input
                    type="radio"
                    name={`${id}-age`}
                    value={band}
                    checked={ageBand === band}
                    onChange={() => setAgeBand(band)}
                    className="h-5 w-5"
                  />
                  {t(`ageBands.${AGE_BAND_KEYS[band]}`)}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="flex items-start gap-3">
            <input
              id={`${id}-agree`}
              type="checkbox"
              checked={agreed}
              onChange={(e) => setAgreed(e.target.checked)}
              className="mt-0.5 h-5 w-5 shrink-0 accent-teal-700"
            />
            <label htmlFor={`${id}-agree`} className="text-slate-800">
              {t("agree")}
            </label>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row">
            <button type="submit" className={primaryButton} disabled={!ageBand || !agreed || starting !== null}>
              {starting === "form" ? t("starting") : t("startForm")}
            </button>
          </div>
          {!ageBand || !agreed ? <p className="text-sm text-slate-600">{t("startHint")}</p> : null}
          {voiceAvailable ? (
            <div className="space-y-3 rounded-2xl border border-slate-200 p-4" data-testid="screen-voice-option">
              {signedIn ? (
                <>
                  <p className="font-medium text-slate-900">{voiceIntent ? t("voiceSignedIn") : t("voicePrompt")}</p>
                  <button
                    ref={voiceButton}
                    type="button"
                    className={secondaryButton}
                    disabled={!ageBand || !agreed || starting !== null || !turnstile.ready || (error !== null && VOICE_OFF_ERRORS.has(error))}
                    onClick={() => void start("voice")}
                  >
                    {starting === "voice" ? t("starting") : t("startVoice")}
                  </button>
                  {turnstile.widget}
                </>
              ) : (
                <Link href={voiceSignInHref("/screen?voice=1")} className="inline-flex min-h-11 items-center font-semibold text-teal-800 underline underline-offset-4">
                  {t("voiceSignIn")}
                </Link>
              )}
            </div>
          ) : (
            <p className="text-sm text-slate-600">{t("errors.voiceUnavailable")}</p>
          )}
          {error ? (
            <p
              role="alert"
              className={
                GUARD_ERRORS.has(error)
                  ? "rounded-2xl bg-amber-50 p-4 text-sm font-medium text-amber-900"
                  : "text-sm font-medium text-red-700"
              }
            >
              {t(`errors.${error}`)}
            </p>
          ) : null}
        </form>
      ) : null}

      {step.kind === "voice" ? (
        <VoiceCheckin
          session={step.session}
          target={step.target}
          dynamicVariables={step.dynamicVariables}
          onStopped={stop}
          onFinished={showResult(step.session.session_id)}
          usageId={step.usageId}
          onContinueByTapping={(answers, reason) =>
            setStep({
              kind: "form",
              sessionId: step.session.session_id,
              questions: step.session.questions,
              answers,
              notice: reason,
            })
          }
        />
      ) : null}

      {step.kind === "form" ? (
        <>
          {step.notice ? (
            <p role="status" className="rounded-2xl bg-amber-50 p-4 text-sm font-medium text-amber-900">
              {step.notice === "demo" ? t("demo") : t(`errors.${step.notice}`)}
            </p>
          ) : null}
          <QuestionForm
            sessionId={step.sessionId}
            questions={step.questions}
            initialAnswers={step.answers}
            onStop={stop}
            onResult={showResult(step.sessionId)}
            onExpired={expired}
          />
        </>
      ) : null}

      {step.kind === "result" ? (
        <ResultView
          sessionId={step.sessionId}
          result={step.result}
          localities={localities}
          viewer={viewer}
          onSaved={storage.clear}
          onRestart={restart}
        />
      ) : null}
    </div>
  );
}
