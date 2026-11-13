"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { upsertLine, type Line } from "@/components/landing/VoiceDemo";
import { UrgentNotice } from "@/components/screen/UrgentNotice";
import { useTurnstile } from "@/components/security/Turnstile";
import { primaryButton, secondaryButton } from "@/components/screen/view";
import type { AgentTool } from "@/lib/agents/booking/constants";
import { runDemoScript, type BookingDemoScript } from "@/lib/agents/booking/demo-script";
import { LANGUAGE_UNAVAILABLE, planVoiceLanguage, responseLanguage, SPEECH_LANG } from "@/lib/agents/languages";
import { formatDateTime, formatInr } from "@/lib/i18n/format";
import { useLocale, useT, useTimeZone } from "@/lib/i18n/client";
import type { Locale } from "@/lib/i18n/config";
import { callSeconds, reportVoiceEnd, voiceStartHeaders } from "@/lib/voice/client";
import { voiceRefusal, voiceSignInHref } from "@/lib/voice/constants";
import type { EndedCall, LiveTarget } from "./LiveBookingCall";
import { CallLanguageNote, VoiceLanguageChoice } from "./VoiceLanguageChoice";

const LiveBookingCall = dynamic(() => import("./LiveBookingCall"), { ssr: false });

type Session = {
  booking_session: string;
  conversation_token: string | null;
  agent_id?: string;
  demo?: boolean;
  dynamic_variables: Record<string, string>;
  /** 051 FR-7: the usage row the widget reports the end against. */
  voice_usage_id?: string;
  max_seconds?: number;
  /** 049: the call language, and the DEMO_MODE conversation in it. */
  language?: Locale;
  demo_script?: BookingDemoScript;
};

export type WidgetHold = {
  appointment_id: string;
  profile_id: string;
  provider_name: string;
  start: string;
  expires_at: string;
  confirm_url: string;
  payment_mode?: "online" | "at_clinic" | "free";
  fee_inr?: number;
};

type Phase = "idle" | "disclosure" | "starting" | "live" | "ended" | "stopped";

/** Pause between scripted lines in DEMO_MODE so the captions read like a conversation. */
const DEMO_LINE_MS = 900;
const POLL_MS = 3000;

/** Milliseconds left, or null before the first tick. */
function useCountdown(expiresAt: string | null): number | null {
  const [left, setLeft] = useState<number | null>(null);
  useEffect(() => {
    if (!expiresAt) return;
    const tick = () => setLeft(Math.max(0, Date.parse(expiresAt) - Date.now()));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);
  return left;
}

const mmss = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}`;

async function fetchHold(): Promise<WidgetHold | null> {
  const res = await fetch("/api/agents/booking/session", { cache: "no-store" }).catch(() => null);
  if (!res?.ok) return null;
  const json = (await res.json().catch(() => null)) as { hold?: WidgetHold | null } | null;
  return json?.hold ?? null;
}

function HoldCard({ hold }: { hold: WidgetHold }) {
  const t = useT("voiceBooking");
  const locale = useLocale();
  const timeZone = useTimeZone();
  const left = useCountdown(hold.expires_at);
  const expired = left !== null && left <= 0;
  const time = formatDateTime(hold.start, locale, timeZone);
  return (
    <section aria-labelledby="voice-hold-title" data-testid="voice-hold" className="space-y-3 rounded-2xl border-2 border-amber-300 bg-amber-50 p-4">
      <h3 id="voice-hold-title" className="font-semibold text-amber-950">
        {t("holdTitle")}
      </h3>
      <p className="text-slate-900">{t("holdCard", { provider: hold.provider_name, time })}</p>
      {expired ? (
        <p role="alert" className="text-sm text-red-800">
          {t("holdExpired")}
        </p>
      ) : (
        <>
          {left !== null ? (
            <p role="timer" aria-live="off" className="text-sm font-medium text-amber-950">
              {t("timeLeft", { time: mmss(left) })}
            </p>
          ) : null}
          <p className="text-sm text-slate-700">{t("confirmNote")}</p>
          {hold.payment_mode === "online" && hold.fee_inr ? (
            <p className="text-sm text-slate-700">{t("payNote", { fee: formatInr(hold.fee_inr * 100, locale) })}</p>
          ) : null}
          <Link href={hold.confirm_url} className={primaryButton}>
            {t("confirm")}
          </Link>
        </>
      )}
    </section>
  );
}

// Ticket 034 FR-4: `Book by voice` on /find. Disclosure -> Start -> live captions -> a hold card with `Sign in and
// confirm` (the 030 booking page attaches the hold after sign-in). DEMO_MODE runs a scripted conversation against the
// same tool handlers. Any failure leaves the normal /find search below untouched.
// 051: voice needs a free sign-in (anonymous visitors get a sign-in link that returns to `/find?voice=1`); quota,
// budget and bot-check refusals point to the search below; the end of every call is reported (FR-7).
// 049: the agent speaks the page language when it has it (`voiceLanguages`); otherwise the widget offers "Voice in
// English" or tapping in the page language (FR-4). DEMO_MODE runs the scripted conversation in the call language.
export function BookingWidget({
  signedIn = true,
  turnstileSiteKey = null,
  voiceLanguages = ["en"],
}: {
  signedIn?: boolean;
  turnstileSiteKey?: string | null;
  /** 049 FR-4: languages enabled on the booking agent (ELEVENLABS_BOOKING_LANGUAGES). */
  voiceLanguages?: Locale[];
}) {
  const t = useT("voiceBooking");
  const tf = useT("voiceAgents.fallback");
  const tl = useT("voiceAgents.languages");
  const locale = useLocale();
  const [languageRefused, setLanguageRefused] = useState(false);
  const plan = languageRefused ? ({ kind: "fallback", language: "en", locale } as const) : planVoiceLanguage(locale, voiceLanguages);
  /** The language the disclosure was opened for: the page language, or English after "Voice in English". */
  const [callChoice, setCallChoice] = useState<Locale>(plan.language);
  const turnstile = useTurnstile(signedIn ? turnstileSiteKey : null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [status, setStatus] = useState<"connecting" | "listening" | "speaking">("connecting");
  const [hold, setHold] = useState<WidgetHold | null>(null);
  const endRef = useRef<(() => void) | null>(null);
  const lineSeq = useRef(0);
  const startRef = useRef<HTMLButtonElement>(null);

  const refreshHold = useCallback(async () => {
    const next = await fetchHold();
    if (next) setHold(next);
  }, []);

  // A live agent holds through server tools: poll this browser's session for the hold while the call runs.
  useEffect(() => {
    if (phase !== "live" || session?.demo) return;
    const timer = setInterval(() => void refreshHold(), POLL_MS);
    return () => clearInterval(timer);
  }, [phase, session?.demo, refreshHold]);

  const endServerSession = () => fetch("/api/agents/booking/session", { method: "DELETE" }).catch(() => null);

  async function start(language: Locale) {
    setPhase("starting");
    setError(null);
    setLines([]);
    setHold(null);
    const res = await fetch("/api/agents/booking/session", {
      method: "POST",
      headers: voiceStartHeaders(turnstile.token),
      body: JSON.stringify({ language }),
    }).catch(() => null);
    turnstile.reset();
    const json = (await res?.json().catch(() => null)) as Session | null;
    if (res?.status === 409 && (json as { error?: string } | null)?.error === LANGUAGE_UNAVAILABLE) {
      setLanguageRefused(true);
      setPhase("idle");
      return;
    }
    if (!res || res.status !== 201 || !json) {
      const refusal = res ? voiceRefusal(res.status, json) : null;
      setError(refusal && refusal !== "notAllowed" ? t(`errors.${refusal}`) : res?.status === 429 ? t("errors.busy") : t("errors.unavailable"));
      setPhase("idle");
      return;
    }
    setSession(json);
    setPhase("live");
    if (json.demo) void runDemo(json);
  }

  async function runDemo(s: Session) {
    setStatus("speaking");
    const startedAt = Date.now();
    const outcome = await runDemoScript({
      bookingSession: s.booking_session,
      today: s.dynamic_variables.today ?? "",
      script: s.demo_script,
      callTool: async (tool: AgentTool, args) => {
        const res = await fetch(`/api/agents/booking/demo/${tool}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(args),
        });
        return { status: res.status, json: ((await res.json().catch(() => ({}))) as Record<string, unknown>) ?? {} };
      },
      say: async (role, text) => {
        lineSeq.current += 1;
        const seq = lineSeq.current;
        setLines((prev) => upsertLine(prev, role === "agent" ? "agent" : "user", seq, text));
        await new Promise((r) => setTimeout(r, DEMO_LINE_MS));
      },
    });
    if (outcome.kind === "held") await refreshHold();
    await endServerSession();
    await reportVoiceEnd(fetch, s.voice_usage_id, callSeconds(startedAt, Date.now()));
    setPhase("ended");
  }

  const onLine = useCallback((role: "user" | "agent", eventId: number, text: string) => setLines((prev) => upsertLine(prev, role, eventId, text)), []);
  const onRedFlag = useCallback(() => {
    setPhase("stopped");
    void endServerSession();
  }, []);
  const usageId = session?.voice_usage_id;
  const onEnded = useCallback(
    (failed: boolean, call: EndedCall) => {
      void endServerSession();
      void reportVoiceEnd(fetch, usageId, call.seconds, call.conversationId);
      void refreshHold();
      setPhase((p) => (p === "stopped" ? p : "ended"));
      if (call.silence) setError(t("errors.silence"));
      else if (failed) setError(t("errors.connect"));
    },
    [refreshHold, t, usageId],
  );

  const target: LiveTarget | null = session && !session.demo
    ? session.conversation_token
      ? { conversationToken: session.conversation_token }
      : session.agent_id
        ? { agentId: session.agent_id, connectionType: "webrtc" }
        : null
    : null;

  const statusText = session?.demo ? t("demo") : t(status);
  const callLanguage = responseLanguage(session);

  return (
    <section aria-labelledby="voice-booking-title" data-testid="voice-booking" className="space-y-4 rounded-2xl border border-teal-200 bg-teal-50/60 p-4 sm:p-5">
      <div className="space-y-1">
        <h2 id="voice-booking-title" className="text-lg font-semibold text-slate-900">
          {t("title")}
        </h2>
        <p className="text-sm text-slate-700">{t("intro")}</p>
      </div>

      {phase === "stopped" ? <UrgentNotice /> : null}

      {phase === "idle" && !signedIn ? (
        <div className="space-y-1" data-testid="voice-booking-sign-in">
          <Link href={voiceSignInHref("/find?voice=1")} className="inline-flex min-h-11 items-center font-semibold text-teal-800 underline underline-offset-4">
            {t("signIn")}
          </Link>
          <p className="text-sm text-slate-700">{t("signInNote")}</p>
        </div>
      ) : null}

      {phase === "idle" && signedIn && plan.kind === "native" ? (
        <button
          ref={startRef}
          type="button"
          className={primaryButton}
          onClick={() => {
            setError(null);
            setCallChoice(plan.language);
            setPhase("disclosure");
          }}
        >
          {t("button")}
        </button>
      ) : null}
      {phase === "idle" && signedIn && plan.kind === "fallback" ? (
        <VoiceLanguageChoice
          message={tf("tapMessage", { language: tl(locale) })}
          onVoiceInEnglish={() => {
            setError(null);
            setCallChoice("en");
            setPhase("disclosure");
          }}
          alternative={{
            label: tf("tapIn", { language: tl(locale) }),
            onClick: () => {
              const search = document.getElementById("find-q");
              search?.scrollIntoView({ block: "center" });
              search?.focus();
            },
          }}
        />
      ) : null}

      {phase === "disclosure" || phase === "starting" ? (
        <div className="space-y-3" role="group" aria-labelledby="voice-booking-disclosure">
          <p id="voice-booking-disclosure" className="font-medium text-slate-900">
            {t("disclosure")}
          </p>
          <p className="text-sm text-slate-700">{t("privacy")}</p>
          <CallLanguageNote language={callChoice} />
          <div className="flex flex-col gap-3 sm:flex-row">
            <button type="button" className={primaryButton} onClick={() => void start(callChoice)} disabled={phase === "starting" || !turnstile.ready}>
              {phase === "starting" ? t("starting") : t("start")}
            </button>
            <button type="button" className={secondaryButton} onClick={() => setPhase("idle")} disabled={phase === "starting"}>
              {t("cancel")}
            </button>
          </div>
          {turnstile.widget}
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="rounded border border-slate-200 bg-white p-3 text-sm text-slate-800">
          {error}
        </p>
      ) : null}

      {phase === "live" ? (
        <div className="space-y-3">
          <p role="status" className="flex items-center gap-2 font-medium text-slate-900">
            <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full bg-teal-500" />
            {statusText}
          </p>
          {target ? (
            <button type="button" className={secondaryButton} onClick={() => endRef.current?.()}>
              {t("end")}
            </button>
          ) : null}
        </div>
      ) : null}
      {/* Stays mounted after a red flag so the agent can say the 108/112 message before the call ends. */}
      {target && (phase === "live" || phase === "stopped") ? (
        <LiveBookingCall
          target={target}
          language={callLanguage}
          dynamicVariables={session?.dynamic_variables ?? {}}
          onLine={onLine}
          onStatus={setStatus}
          onRedFlag={onRedFlag}
          onEnded={onEnded}
          endRef={endRef}
        />
      ) : null}

      {phase !== "stopped" && lines.length > 0 ? (
        <ol aria-label={t("captions")} aria-live="polite" role="log" className="max-h-72 space-y-2 overflow-y-auto pr-1" data-testid="voice-captions">
          {lines.map((l) => (
            <li
              key={l.key}
              className={`rounded-xl px-3 py-2 text-sm leading-relaxed ${l.role === "agent" ? "bg-white text-slate-800" : "ml-6 bg-slate-100 text-slate-700"}`}
            >
              <span className="mr-1.5 text-xs font-semibold text-slate-600">{l.role === "agent" ? t("speakerAi") : t("speakerYou")}</span>
              <span lang={SPEECH_LANG[callLanguage]}>{l.text}</span>
            </li>
          ))}
        </ol>
      ) : null}

      {phase !== "stopped" && hold ? <HoldCard hold={hold} /> : null}

      {phase === "ended" ? (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <p className="text-sm text-slate-700">{t("ended")}</p>
          <button
            type="button"
            className={secondaryButton}
            onClick={() => {
              setSession(null);
              setPhase("disclosure");
            }}
          >
            {t("again")}
          </button>
        </div>
      ) : null}
    </section>
  );
}
