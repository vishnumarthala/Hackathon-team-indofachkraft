"use client";

import { useRef, useState } from "react";
import { SPEECH_LANG } from "@/lib/agents/languages";
import { answerWords, screenDemoTurn, type ScreenDemoScript } from "@/lib/agents/screen/demo-script";
import { useT } from "@/lib/i18n/client";
import { finishScreen, screenClientTools, type StartedSession } from "@/lib/screen/client";
import type { ScreenResult } from "@/lib/screen/questions";
import { primaryButton, secondaryButton, smallButton } from "./view";

type Line = { role: "agent" | "parent"; text: string; lang: string; note?: string; safety?: boolean };

type Props = {
  session: StartedSession;
  script: ScreenDemoScript;
  onStopped: () => void;
  onFinished: (result: ScreenResult) => void;
  onContinueByTapping: (answers: Record<string, string>) => void;
};

/** Pause before the page shows only the 108/112 message, so the agent's safety line can be read. */
const SAFETY_LINE_MS = 2500;

// Ticket 049 (E-1): the DEMO_MODE voice check-in in the call language. No live call: the agent's first message and
// lines are the call language's catalogue text, the questions stay English (clinical translation review pending; the
// live agent asks them in the call language), and what the parent taps or types is mapped to the same tool calls as the
// live agent (`record_answer` / `record_red_flag` through screenClientTools). A red flag shows the 108/112 message.
export function DemoVoiceCheckin({ session, script, onStopped, onFinished, onContinueByTapping }: Props) {
  const t = useT("voiceAgents.screen");
  const tv = useT("screen.voice");
  const tl = useT("voiceAgents.languages");
  const callLang = SPEECH_LANG[script.language];
  const line = (role: Line["role"], text: string, lang = callLang): Line => ({ role, text, lang });
  const ask = (index: number): Line => ({
    role: "agent",
    text: session.questions[index].text,
    lang: "en",
    note: script.language === "en" ? undefined : t("demoQuestionNote", { language: tl(script.language) }),
  });
  const [lines, setLines] = useState<Line[]>(() => [line("agent", script.first_message), ...(session.questions.length ? [ask(0)] : [])]);
  const [index, setIndex] = useState(0);
  const [said, setSaid] = useState("");
  const [busy, setBusy] = useState(false);
  const [answered, setAnswered] = useState(0);
  const [phase, setPhase] = useState<"live" | "stopped" | "finishing">("live");
  const answers = useRef<Record<string, string>>({});

  const question = session.questions[index];

  async function reply(text: string) {
    if (!question || busy || phase !== "live" || !text.trim()) return;
    setSaid("");
    const call = screenDemoTurn(script, question, text);
    const parent = line("parent", text.trim());
    if (!call) {
      setLines((prev) => [...prev, parent, line("agent", script.unclear)]);
      return;
    }
    setLines((prev) => [...prev, parent]);
    setBusy(true);
    const out: { next: number | null; stopped: boolean; complete: boolean } = { next: null, stopped: false, complete: false };
    const tools = screenClientTools(
      session.session_id,
      { fetchFn: (input, init) => fetch(input, init) },
      {
        onAnswer: (itemId, answer, missing) => {
          answers.current = { ...answers.current, [itemId]: answer };
          setAnswered(session.questions.length - missing.length);
          const first = session.questions.findIndex((q) => missing.includes(q.id));
          out.next = first === -1 ? null : first;
        },
        onStop: () => {
          out.stopped = true;
        },
        onComplete: () => {
          out.complete = true;
        },
      },
    );
    if (call.tool === "record_red_flag") await tools.record_red_flag(call.params);
    else await tools.record_answer(call.params);
    setBusy(false);

    const { next, stopped, complete } = out;
    if (stopped) {
      setPhase("stopped");
      setLines((prev) => [...prev, { ...line("agent", script.safety_message), safety: true }]);
      setTimeout(onStopped, SAFETY_LINE_MS);
      return;
    }
    if (complete) {
      setPhase("finishing");
      setLines((prev) => [...prev, line("agent", script.closing)]);
      const done = await finishScreen(fetch, session.session_id);
      if (done.ok) return done.result.red_flag ? onStopped() : onFinished(done.result);
      return onContinueByTapping(answers.current);
    }
    if (next === null || next === index) {
      // Not saved (closed session, network): the tap-through form keeps the answers so far.
      if (next === null) onContinueByTapping(answers.current);
      return;
    }
    setIndex(next);
    setLines((prev) => [...prev, ask(next)]);
  }

  return (
    <div className="space-y-4" data-testid="screen-demo-voice" data-language={script.language}>
      <p role="status" className="rounded-2xl bg-amber-50 p-4 text-sm font-medium text-amber-900">
        {t("demo")}
      </p>
      <p className="text-sm text-slate-600">{tv("progress", { answered, total: session.questions.length })}</p>
      <ol aria-label={tv("transcript")} aria-live="polite" className="max-h-96 space-y-2 overflow-y-auto pr-1" data-testid="screen-demo-transcript">
        {lines.map((l, i) => (
          <li
            key={i}
            data-testid={l.safety ? "screen-demo-safety" : undefined}
            className={`rounded-xl px-3 py-2 text-sm leading-relaxed ${
              l.safety ? "border-2 border-red-600 bg-red-50 font-semibold text-red-900" : l.role === "agent" ? "bg-teal-50 text-slate-800" : "ml-6 bg-slate-100 text-slate-700"
            }`}
          >
            <span className="mr-1.5 text-xs font-semibold text-slate-600">{l.role === "agent" ? tv("speakerAi") : tv("speakerYou")}</span>
            <span lang={l.lang}>{l.text}</span>
            {l.note ? <span className="mt-1 block text-xs text-slate-600">{l.note}</span> : null}
          </li>
        ))}
      </ol>
      {phase === "live" && question ? (
        <div className="space-y-3">
          <p className="font-semibold text-slate-900">{t("demoSay")}</p>
          <div className="flex flex-wrap gap-2" data-testid="screen-demo-replies">
            {answerWords(script, question.answers).map(({ code, word }) => (
              <button key={code} type="button" className={smallButton} disabled={busy} onClick={() => void reply(word)} data-answer={code}>
                <span lang={callLang}>{word}</span>
              </button>
            ))}
          </div>
          <form
            className="flex flex-col gap-2 sm:flex-row"
            onSubmit={(e) => {
              e.preventDefault();
              void reply(said);
            }}
          >
            <label htmlFor="screen-demo-said" className="sr-only">
              {t("demoType")}
            </label>
            <input
              id="screen-demo-said"
              lang={callLang}
              maxLength={300}
              value={said}
              placeholder={t("demoType")}
              onChange={(e) => setSaid(e.target.value)}
              className="min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-base text-slate-900"
            />
            <button type="submit" className={primaryButton} disabled={busy || !said.trim()}>
              {t("demoSend")}
            </button>
          </form>
        </div>
      ) : null}
      {phase === "finishing" ? <p role="status">{tv("finishing")}</p> : null}
      {phase === "live" ? (
        <button type="button" className={secondaryButton} onClick={() => onContinueByTapping(answers.current)}>
          {tv("switchToForm")}
        </button>
      ) : null}
    </div>
  );
}
