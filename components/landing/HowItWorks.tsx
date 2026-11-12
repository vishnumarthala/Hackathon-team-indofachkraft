"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { useT } from "@/lib/i18n/client";
import type { TFunction } from "@/lib/i18n/keys";
import { LoopVideo } from "./LoopVideo";
import { CheckIcon, Wave } from "./ui";

const DURATION = 9000;

type Step = {
  key: string;
  label: string;
  title: string;
  text: string;
  points: string[];
  video: string;
  poster: string;
  mock: ReactNode;
};

function Panel({ children }: { children: ReactNode }) {
  return (
    <div className="absolute bottom-4 left-4 right-4 rounded-2xl border border-white/70 bg-white/95 p-4 shadow-2xl shadow-[#0b1f1d]/25 backdrop-blur sm:bottom-6 sm:left-auto sm:right-6 sm:w-[330px]">
      {children}
    </div>
  );
}

const STEP_COUNT = 3;

function buildSteps(t: TFunction<"landing.how">, tReel: TFunction<"landing.reel">): Step[] {
  return [
  {
    key: "intake",
    label: t("intakeLabel"),
    title: t("intakeTitle"),
    text: t("intakeText"),
    points: [t("intakePoint1"), t("intakePoint2"), t("intakePoint3")],
    video: "/landing/intake.mp4",
    poster: "/landing/intake.jpg",
    mock: (
      <Panel>
        <div className="mb-3 flex items-center justify-between">
          <p className="text-[0.7rem] font-semibold uppercase tracking-wider text-teal-700">{t("briefTitle")}</p>
          <Wave />
        </div>
        <p className="mb-2 text-sm font-semibold text-[#0b1f1d]">{t("briefChild")}</p>
        <ul className="space-y-1.5 text-[0.8rem] text-slate-600">
          <li><span className="font-medium text-slate-800">{t("briefConcernLabel")}</span> {t("briefConcern")}</li>
          <li><span className="font-medium text-slate-800">{t("briefNoticedLabel")}</span> {t("briefNoticed")}</li>
          <li><span className="font-medium text-slate-800">{t("briefWatchLabel")}</span> {t("briefWatch")}</li>
        </ul>
      </Panel>
    ),
  },
  {
    key: "session",
    label: t("sessionLabel"),
    title: t("sessionTitle"),
    text: t("sessionText"),
    points: [t("sessionPoint1"), t("sessionPoint2"), t("sessionPoint3")],
    video: "/landing/session.mp4",
    poster: "/landing/session.jpg",
    mock: (
      <Panel>
        <div className="mb-3 flex items-center justify-between">
          <p className="text-[0.7rem] font-semibold uppercase tracking-wider text-teal-700">{t("reviewTitle")}</p>
          <span className="text-xs font-medium text-slate-500">{t("reviewProgress")}</span>
        </div>
        <div className="mb-3 h-1.5 overflow-hidden rounded-full bg-slate-100">
          <div className="h-full w-[95%] rounded-full bg-teal-600" />
        </div>
        {/* ISAA item texts: not translated (clinical instrument items). */}
        {[
          { n: 15, t: "Acquired speech and lost it", q: t("quoteLostSpeech"), ts: "01:18" },
          { n: 31, t: "Unusually sensitive to sensory stimuli", q: t("quoteSensory"), ts: "02:05" },
        ].map((r) => (
          <div key={r.n} className="mb-2 rounded-xl bg-slate-50 p-2.5 last:mb-0">
            <div className="flex items-center justify-between text-[0.8rem] font-semibold text-slate-800">
              <span lang="en">
                {r.n}. {r.t}
              </span>
              <span className="font-mono text-[0.7rem] font-normal text-slate-500">{r.ts}</span>
            </div>
            <p className="mt-0.5 text-xs italic text-slate-500">&ldquo;{r.q}&rdquo;</p>
          </div>
        ))}
      </Panel>
    ),
  },
  {
    key: "handoff",
    label: t("handoffLabel"),
    title: t("handoffTitle"),
    text: t("handoffText"),
    points: [t("handoffPoint1"), t("handoffPoint2"), t("handoffPoint3")],
    video: "/landing/specialist.mp4",
    poster: "/landing/specialist.jpg",
    mock: (
      <Panel>
        <p className="mb-3 text-[0.7rem] font-semibold uppercase tracking-wider text-teal-700">{t("packetTitle")}</p>
        <ul className="mb-3 space-y-1.5">
          {[tReel("packetIntake"), t("packetIsaa"), tReel("packetReport"), tReel("packetVoiceNote")].map((x) => (
            <li key={x} className="flex items-center gap-2 text-[0.82rem] text-slate-700">
              <CheckIcon className="h-4 w-4 text-teal-600" />
              {x}
            </li>
          ))}
        </ul>
        <div className="flex h-9 items-center justify-center rounded-full bg-[#0b1f1d] text-xs font-semibold text-white">
          {tReel("sendToSpecialist")}
        </div>
      </Panel>
    ),
  },
  ];
}

export function HowItWorks() {
  const t = useT("landing.how");
  const tReel = useT("landing.reel");
  const STEPS = useMemo(() => buildSteps(t, tReel), [t, tReel]);
  const [active, setActive] = useState(0);
  const [auto, setAuto] = useState(true);
  const [inView, setInView] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);

  // Only auto-advance while the section is on screen, so visitors always arrive at step 1.
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => setInView(e.isIntersecting), { threshold: 0.35 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!auto || !inView) return;
    const id = window.setTimeout(() => {
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return setAuto(false);
      setActive((a) => (a + 1) % STEP_COUNT);
    }, DURATION);
    return () => window.clearTimeout(id);
  }, [active, auto, inView]);

  function select(i: number) {
    setAuto(false);
    setActive(i);
  }

  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const next = (active + (e.key === "ArrowRight" ? 1 : STEPS.length - 1)) % STEPS.length;
    select(next);
    tabs.current[next]?.focus();
  }

  const step = STEPS[active];

  return (
    <div ref={rootRef} className="grid items-start gap-10 lg:grid-cols-[0.9fr_1.1fr] lg:gap-14">
      <div>
        <div role="tablist" aria-label={t("tablistLabel")} onKeyDown={onKey} className="flex flex-col gap-3">
          {STEPS.map((s, i) => {
            const selected = i === active;
            return (
              <button
                key={s.key}
                ref={(el) => {
                  tabs.current[i] = el;
                }}
                role="tab"
                id={`tab-${s.key}`}
                aria-selected={selected}
                aria-controls={`panel-${s.key}`}
                tabIndex={selected ? 0 : -1}
                onClick={() => select(i)}
                className={`group relative overflow-hidden rounded-2xl border p-5 text-left transition-all duration-300 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-600/30 ${
                  selected
                    ? "border-[#0b1f1d]/10 bg-white shadow-xl shadow-[#0b1f1d]/[0.06]"
                    : "border-transparent hover:bg-white/60"
                }`}
              >
                <span className={`block text-sm font-semibold ${selected ? "text-teal-700" : "text-slate-500"}`}>{s.label}</span>
                <span className={`mt-1 block text-lg font-semibold leading-snug ${selected ? "text-[#0b1f1d]" : "text-slate-600 group-hover:text-[#0b1f1d]"}`}>
                  {s.title}
                </span>
                {selected && (
                  <div className="lp-panel-in">
                    <p className="mt-3 text-[0.95rem] leading-relaxed text-slate-600">{s.text}</p>
                    <ul className="mt-4 space-y-2">
                      {s.points.map((p) => (
                        <li key={p} className="flex items-start gap-2.5 text-sm text-slate-700">
                          <CheckIcon className="mt-px h-4.5 w-4.5 text-teal-600" />
                          {p}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {selected && (
                  <span className="absolute inset-x-0 bottom-0 h-[3px] bg-slate-100">
                    <span
                      key={`${active}-${auto}-${inView}`}
                      className={`block h-full bg-teal-600 ${auto && inView ? "lp-progress" : ""}`}
                      style={{ "--dur": `${DURATION}ms`, transform: auto && inView ? undefined : auto ? "scaleX(0)" : "scaleX(1)" } as CSSProperties}
                    />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      <div
        role="tabpanel"
        id={`panel-${step.key}`}
        aria-labelledby={`tab-${step.key}`}
        className="relative aspect-[4/5] overflow-hidden rounded-[28px] bg-[#e7e1d6] shadow-[0_40px_80px_-40px_rgba(11,31,29,0.5)] sm:aspect-[16/12] lg:sticky lg:top-24"
      >
        {STEPS.map((s, i) => (
          <div
            key={s.key}
            className={`absolute inset-0 transition-opacity duration-700 ${i === active ? "opacity-100" : "pointer-events-none opacity-0"}`}
            aria-hidden={i !== active}
          >
            <LoopVideo src={s.video} poster={s.poster} className="absolute inset-0 h-full w-full object-cover" />
            <div className="absolute inset-0 bg-gradient-to-t from-[#0b1f1d]/50 via-transparent to-transparent" />
          </div>
        ))}
        <div key={step.key} className="lp-panel-in">
          {step.mock}
        </div>
      </div>
    </div>
  );
}
