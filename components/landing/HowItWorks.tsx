"use client";

import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
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

const STEPS: Step[] = [
  {
    key: "intake",
    label: "1. Intake call",
    title: "CareThread talks to the parent before the first session",
    text: "Send the parent a link. CareThread holds a calm, guided conversation in their language, right in the browser. You open the case to a pre-session brief instead of a blank page.",
    points: ["No app to install for parents", "Consent before anything is recorded", "English, Hindi and Telugu today, German coming soon"],
    video: "/landing/intake.mp4",
    poster: "/landing/intake.jpg",
    mock: (
      <Panel>
        <div className="mb-3 flex items-center justify-between">
          <p className="text-[0.7rem] font-semibold uppercase tracking-wider text-teal-700">Pre-session brief</p>
          <Wave />
        </div>
        <p className="mb-2 text-sm font-semibold text-[#0b1f1d]">Ravi, 3 years</p>
        <ul className="space-y-1.5 text-[0.8rem] text-slate-600">
          <li><span className="font-medium text-slate-800">Main concern:</span> few words, does not answer to his name</li>
          <li><span className="font-medium text-slate-800">First noticed:</span> around 18 months</li>
          <li><span className="font-medium text-slate-800">Watch for:</span> eye contact, play with toys</li>
        </ul>
      </Panel>
    ),
  },
  {
    key: "session",
    label: "2. Online session",
    title: "Run the session. CareThread fills the ISAA form",
    text: "Upload or record the online session. CareThread transcribes it and suggests a rating for each of the 40 ISAA items, each linked to the exact quote and timestamp. Nothing counts until you confirm it.",
    points: ["Evidence quote and timestamp on every item", "Confirm or edit each rating in one click", "Score updates as you confirm"],
    video: "/landing/session.mp4",
    poster: "/landing/session.jpg",
    mock: (
      <Panel>
        <div className="mb-3 flex items-center justify-between">
          <p className="text-[0.7rem] font-semibold uppercase tracking-wider text-teal-700">ISAA review</p>
          <span className="text-xs font-medium text-slate-500">38 / 40 confirmed</span>
        </div>
        <div className="mb-3 h-1.5 overflow-hidden rounded-full bg-slate-100">
          <div className="h-full w-[95%] rounded-full bg-teal-600" />
        </div>
        {[
          { n: 15, t: "Acquired speech and lost it", q: "said a few words at two, then stopped", ts: "01:18" },
          { n: 31, t: "Unusually sensitive to sensory stimuli", q: "covers his ears at the mixer", ts: "02:05" },
        ].map((r) => (
          <div key={r.n} className="mb-2 rounded-xl bg-slate-50 p-2.5 last:mb-0">
            <div className="flex items-center justify-between text-[0.8rem] font-semibold text-slate-800">
              <span>
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
    label: "3. Specialist handoff",
    title: "Hand the complete case to the specialist",
    text: "Mark the report final and CareThread builds the referral packet: intake, confirmed ISAA with evidence, and the parent's voice note. The specialist opens it by link and can ask the case questions.",
    points: ["Report drafted from confirmed items only", "One link for the specialist, no account", "Ask the case: answers cite their source"],
    video: "/landing/specialist.mp4",
    poster: "/landing/specialist.jpg",
    mock: (
      <Panel>
        <p className="mb-3 text-[0.7rem] font-semibold uppercase tracking-wider text-teal-700">Referral packet</p>
        <ul className="mb-3 space-y-1.5">
          {["Intake summary", "ISAA with evidence", "Therapist report", "Parent voice note"].map((x) => (
            <li key={x} className="flex items-center gap-2 text-[0.82rem] text-slate-700">
              <CheckIcon className="h-4 w-4 text-teal-600" />
              {x}
            </li>
          ))}
        </ul>
        <div className="flex h-9 items-center justify-center rounded-full bg-[#0b1f1d] text-xs font-semibold text-white">
          Send to specialist
        </div>
      </Panel>
    ),
  },
];

export function HowItWorks() {
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
      setActive((a) => (a + 1) % STEPS.length);
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
        <div role="tablist" aria-label="How CareThread works" onKeyDown={onKey} className="flex flex-col gap-3">
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
