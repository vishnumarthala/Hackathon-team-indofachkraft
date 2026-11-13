"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { useTurnstile } from "@/components/security/Turnstile";
import { CallLanguageNote, VoiceLanguageChoice } from "@/components/voice/VoiceLanguageChoice";
import { planVoiceLanguage } from "@/lib/agents/languages";
import type { ScreenDemoScript } from "@/lib/agents/screen/demo-script";
import { useLocale, useT } from "@/lib/i18n/client";
import type { Locale } from "@/lib/i18n/config";
import { SESSION_STORAGE_KEY, startScreen, type StartError, type StartedSession } from "@/lib/screen/client";
import {
  concernsFor,
  isQuestionAgeBand,
  SCREEN_AGE_BANDS,
  type ScreenAgeBand,
  type ScreenConcern,
  type ScreenMode,
  type ScreenQuestion,
  type ScreenResult,
} from "@/lib/screen/questions";
import { voiceSignInHref } from "@/lib/voice/constants";
import { Over8Notice, Under18Guidance } from "./AgeGuidance";
import { DemoVoiceCheckin } from "./DemoVoiceCheckin";
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
      language: Locale;
    }
  /** 049: DEMO_MODE voice check-in in the call language (no live call). */
  | { kind: "demoVoice"; session: StartedSession; script: ScreenDemoScript }
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
// 048: children up to 8. `under-18m` shows milestone guidance and `9y+` a short "talk to a professional" note
// instead of the check-in; the other bands ask "What worries you most?" (codes only) before the questions.
// 051 FR-1: tapping is the primary, anonymous path ("Start free check-in"); voice needs a free sign-in and returns
// here with `?voice=1`. Quota, budget and bot-check refusals keep the tap option on screen.
// 049: voice speaks the page language when the agent has it (`voiceLanguages`); otherwise the page offers "Voice in
// English" or tapping in the page language (FR-4). DEMO_MODE runs the scripted voice check-in in the call language.
export function ScreenFlow({
  viewer,
  localities,
  voiceAvailable,
  voiceLanguages = ["en"],
  turnstileSiteKey = null,
  voiceIntent = false,
}: {
  viewer: SaveViewer;
  localities: LocalityOption[];
  voiceAvailable: boolean;
  /** 049 FR-4: languages enabled on the screen agent (ELEVENLABS_SCREEN_LANGUAGES). */
  voiceLanguages?: Locale[];
  /** 051 FR-8: Cloudflare Turnstile site key (null = no bot check). */
  turnstileSiteKey?: string | null;
  /** 051: back from signing in to use voice (`/screen?voice=1`). */
  voiceIntent?: boolean;
}) {
  const t = useT("screen");
  const tf = useT("voiceAgents.fallback");
  const tl = useT("voiceAgents.languages");
  const locale = useLocale();
  const id = useId();
  const [step, setStep] = useState<Step>({ kind: "intro" });
  const [ageBand, setAgeBand] = useState<ScreenAgeBand | null>(null);
  const [concerns, setConcerns] = useState<ScreenConcern[]>([]);
  const [agreed, setAgreed] = useState(false);
  const [starting, setStarting] = useState<ScreenMode | null>(null);
  const [error, setError] = useState<Exclude<StartError, "languageUnavailable"> | "expired" | null>(null);
  // 049: the server said the agent does not speak this language (its list changed since the page loaded).
  const [languageRefused, setLanguageRefused] = useState(false);
  const plan = languageRefused ? ({ kind: "fallback", language: "en", locale } as const) : planVoiceLanguage(locale, voiceLanguages);
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

  const questionBand = isQuestionAgeBand(ageBand) ? ageBand : null;
  const offeredConcerns = questionBand ? concernsFor(questionBand) : [];

  async function start(mode: ScreenMode, language?: Locale) {
    if (!questionBand || !agreed) return;
    setError(null);
    setStarting(mode);
    const outcome = await startScreen(
      questionBand,
      mode,
      {
        fetchFn: (input, init) => fetch(input, init),
        getMicrophone: () => navigator.mediaDevices.getUserMedia({ audio: true }),
        turnstileToken: turnstile.token,
      },
      concerns.filter((c) => offeredConcerns.includes(c)),
      mode === "voice" ? language : undefined,
    );
    if (mode === "voice") turnstile.reset();
    setStarting(null);
    if (outcome.kind === "error") {
      if (outcome.error === "languageUnavailable") return setLanguageRefused(true);
      return setError(outcome.error);
    }
    storage.set(outcome.session.session_id);
    const form = (notice: Notice) =>
      setStep({ kind: "form", sessionId: outcome.session.session_id, questions: outcome.session.questions, answers: {}, notice });
    if (outcome.kind === "form") return form(null);
    if (outcome.kind === "demo" && outcome.script) return setStep({ kind: "demoVoice", session: outcome.session, script: outcome.script });
    if (outcome.kind === "demo") return form("demo");
    if (outcome.kind === "micDenied") return form("mic");
    setStep({
      kind: "voice",
      session: outcome.session,
      target: outcome.target,
      dynamicVariables: outcome.dynamicVariables,
      usageId: outcome.usage.id,
      language: outcome.language,
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
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
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
          {ageBand === "under-18m" ? <Under18Guidance /> : null}
          {ageBand === "9y+" ? <Over8Notice /> : null}
          {ageBand === "under-18m" || ageBand === "9y+" ? null : (
            <>
              {questionBand ? (
                <fieldset className="space-y-2" data-testid="screen-concerns">
                  <legend className="mb-1 text-base font-semibold text-slate-900">{t("concerns.title")}</legend>
                  <p className="text-sm text-slate-700">{t("concerns.hint")}</p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {offeredConcerns.map((concern) => {
                      const checked = concerns.includes(concern);
                      return (
                        <label
                          key={concern}
                          className={`flex min-h-12 cursor-pointer items-center gap-3 rounded-xl border px-3 py-2 ${
                            checked ? "border-teal-700 bg-teal-50 font-semibold text-teal-900" : "border-slate-300 text-slate-800"
                          }`}
                        >
                          <input
                            type="checkbox"
                            name={`${id}-concern`}
                            value={concern}
                            checked={checked}
                            onChange={(e) =>
                              setConcerns((list) => (e.target.checked ? [...list, concern] : list.filter((c) => c !== concern)))
                            }
                            className="h-5 w-5 shrink-0 accent-teal-700"
                          />
                          {t(`concerns.options.${concern}`)}
                        </label>
                      );
                    })}
                  </div>
                </fieldset>
              ) : null}
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
                <button type="submit" className={primaryButton} disabled={!questionBand || !agreed || starting !== null}>
                  {starting === "form" ? t("starting") : t("startForm")}
                </button>
              </div>
              {!questionBand || !agreed ? <p className="text-sm text-slate-600">{t("startHint")}</p> : null}
              {voiceAvailable ? (
                <div className="space-y-3 rounded-2xl border border-slate-200 p-4" data-testid="screen-voice-option">
                  {signedIn ? (
                    <>
                      <p className="font-medium text-slate-900">{voiceIntent ? t("voiceSignedIn") : t("voicePrompt")}</p>
                      {plan.kind === "native" ? (
                        <>
                          <CallLanguageNote />
                          <button
                            ref={voiceButton}
                            type="button"
                            className={secondaryButton}
                            disabled={!questionBand || !agreed || starting !== null || !turnstile.ready || (error !== null && VOICE_OFF_ERRORS.has(error))}
                            onClick={() => void start("voice", plan.language)}
                          >
                            {starting === "voice" ? t("starting") : t("startVoice")}
                          </button>
                        </>
                      ) : (
                        <VoiceLanguageChoice
                          message={tf("tapMessage", { language: tl(locale) })}
                          onVoiceInEnglish={() => void start("voice", "en")}
                          alternative={{ label: tf("tapIn", { language: tl(locale) }), onClick: () => void start("form") }}
                          disabled={!questionBand || !agreed || starting !== null || !turnstile.ready || (error !== null && VOICE_OFF_ERRORS.has(error))}
                        />
                      )}
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
            </>
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

      {step.kind === "demoVoice" ? (
        <DemoVoiceCheckin
          session={step.session}
          script={step.script}
          onStopped={stop}
          onFinished={showResult(step.session.session_id)}
          onContinueByTapping={(answers) =>
            setStep({ kind: "form", sessionId: step.session.session_id, questions: step.session.questions, answers, notice: null })
          }
        />
      ) : null}

      {step.kind === "voice" ? (
        <VoiceCheckin
          session={step.session}
          target={step.target}
          language={step.language}
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
          onUpdated={showResult(step.sessionId)}
          onExpired={expired}
        />
      ) : null}
    </div>
  );
}
