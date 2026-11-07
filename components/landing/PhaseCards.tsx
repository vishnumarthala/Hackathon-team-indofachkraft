import type { ReactNode } from "react";
import "./landing.css";
import { Reveal } from "./Reveal";

const icon = "h-6 w-6";

const PHASES: { title: string; text: string; who: string; icon: ReactNode; tint: string }[] = [
  {
    title: "1. Intake call",
    text: "Before the first visit, an AI voice assistant talks to the parent in English or German (also Hindi and Telugu) and prepares a pre-session brief for the therapist.",
    who: "Parent → Therapist",
    tint: "from-amber-100 to-orange-50 text-orange-700",
    icon: (
      <svg className={icon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z" />
        <path d="M19 11a7 7 0 0 1-14 0M12 18v3" />
      </svg>
    ),
  },
  {
    title: "2. Online session",
    text: "During the session, CareThread suggests a rating for each of the 40 ISAA items with an evidence quote and timestamp, and the therapist confirms or edits every one.",
    who: "Therapist confirms",
    tint: "from-teal-100 to-emerald-50 text-teal-700",
    icon: (
      <svg className={icon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
        <rect x="4" y="3" width="16" height="18" rx="2" />
        <path d="m8.5 12 2.2 2.2L15.5 9.5M8 17h8" />
      </svg>
    ),
  },
  {
    title: "3. Specialist handoff",
    text: "When a referral is needed, the specialist receives the complete case and can ask questions that are answered with cited evidence.",
    who: "Therapist → Specialist",
    tint: "from-sky-100 to-indigo-50 text-sky-700",
    icon: (
      <svg className={icon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 3h7v7M21 3l-9 9" />
        <path d="M19 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5" />
      </svg>
    ),
  },
];

export function PhaseCards() {
  return (
    <div className="relative">
      {/* The thread that ties the three phases together (desktop only) */}
      <svg
        className="pointer-events-none absolute inset-x-0 top-14 hidden h-10 w-full sm:block"
        viewBox="0 0 1000 40"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <path
          className="lp-thread"
          d="M60 20 C 230 -10, 330 50, 500 20 S 770 -10, 940 20"
          fill="none"
          stroke="url(#threadGradient)"
          strokeWidth="3"
          strokeLinecap="round"
        />
        <defs>
          <linearGradient id="threadGradient" x1="0" x2="1">
            <stop offset="0%" stopColor="#fb923c" />
            <stop offset="50%" stopColor="#0d9488" />
            <stop offset="100%" stopColor="#0284c7" />
          </linearGradient>
        </defs>
      </svg>

      <ol className="relative grid gap-5 sm:grid-cols-3">
        {PHASES.map((p, i) => (
          <Reveal as="li" key={p.title} delay={i * 120}>
            <div
              className={`lp-card h-full rounded-3xl border border-slate-200/80 bg-white/90 p-6 shadow-sm backdrop-blur`}
            >
              <div
                className={`mb-5 flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br ring-4 ring-white ${p.tint}`}
              >
                {p.icon}
              </div>
              <h3 className="mb-2 text-lg font-bold text-slate-900">{p.title}</h3>
              <p className="mb-4 leading-relaxed text-slate-600">{p.text}</p>
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">{p.who}</p>
            </div>
          </Reveal>
        ))}
      </ol>
    </div>
  );
}
