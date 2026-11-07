import type { CSSProperties } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { HeroVisual } from "@/components/landing/HeroVisual";
import "@/components/landing/landing.css";
import { PhaseCards } from "@/components/landing/PhaseCards";
import { PilotForm } from "@/components/landing/PilotForm";
import { Reveal } from "@/components/landing/Reveal";

const SUBTITLE =
  "CareThread is the AI assistant for early intervention therapists. It talks to the parent before the first session, documents the online session and fills the assessment form, and hands the complete case to the specialist.";

export const metadata: Metadata = {
  title: "CareThread - AI assistant for early intervention therapists",
  description: "CareThread is the AI assistant for early intervention therapists.",
};

const delay = (ms: number) => ({ "--d": `${ms}ms` }) as CSSProperties;

const STATS = [
  { value: "40", label: "ISAA items, each with an evidence quote and timestamp" },
  { value: "3", label: "languages for the parent: Telugu, Hindi and English" },
  { value: "1", label: "thread from the first call to the specialist" },
];

const TRUST = [
  { title: "Consent first", text: "Parents agree before any call or recording starts." },
  { title: "Evidence on every item", text: "Each suggestion links to the exact moment in the session." },
  { title: "Clinician confirms", text: "Nothing reaches the report until the therapist confirms or edits it." },
  { title: "Built for HIPAA and GDPR", text: "Consent, encryption, audit log, EU or India data residency." },
];

const PILOT_PERKS = [
  "Help shape the product with direct access to the team",
  "Parent calls in Telugu, Hindi and English",
  "Try it first on synthetic role-play sessions, no real patients",
];

function Check() {
  return (
    <svg className="mt-0.5 h-5 w-5 shrink-0 text-teal-600" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path
        fillRule="evenodd"
        d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm3.7-9.3a1 1 0 0 0-1.4-1.4L9 10.6 7.7 9.3a1 1 0 0 0-1.4 1.4l2 2a1 1 0 0 0 1.4 0l4-4Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

export default function Home() {
  return (
    <div className="bg-[#fbfaf7] text-slate-900">
      {/* HERO */}
      <section className="relative overflow-hidden">
        <div aria-hidden="true">
          <div className="lp-blob" style={{ width: 420, height: 420, top: -120, left: -120, background: "#99f6e4" }} />
          <div
            className="lp-blob"
            style={{ width: 360, height: 360, top: 80, right: -140, background: "#fed7aa", animationDelay: "-6s" }}
          />
          <div
            className="lp-blob"
            style={{ width: 300, height: 300, bottom: -160, left: "40%", background: "#bae6fd", animationDelay: "-11s" }}
          />
          <div
            className="absolute inset-0 opacity-[0.35]"
            style={{
              backgroundImage: "radial-gradient(rgba(15,118,110,0.18) 1px, transparent 1px)",
              backgroundSize: "22px 22px",
              maskImage: "radial-gradient(ellipse at center, black 30%, transparent 75%)",
              WebkitMaskImage: "radial-gradient(ellipse at center, black 30%, transparent 75%)",
            }}
          />
        </div>

        <div className="relative mx-auto grid w-full max-w-6xl items-center gap-14 px-4 pb-20 pt-14 sm:pt-20 lg:grid-cols-[1.1fr_1fr] lg:pb-28">
          <div>
            <p
              className={`lp-fade-up mb-6 inline-flex items-center gap-2 rounded-full border border-teal-200 bg-white/70 px-3 py-1 text-sm font-medium text-teal-800 backdrop-blur`}
              style={delay(0)}
            >
              <span className={`lp-pulse h-2 w-2 rounded-full bg-teal-500`} />
              Pilot open for centres in India and Germany
            </p>

            <h1
              className={`lp-fade-up mb-6 text-5xl font-extrabold tracking-tight sm:text-6xl lg:text-7xl`}
              style={delay(100)}
            >
              <span className="lp-gradient-text">CareThread</span>
            </h1>

            <p
              className={`lp-fade-up mb-8 max-w-xl text-lg leading-relaxed text-slate-600 sm:text-xl`}
              style={delay(200)}
            >
              {SUBTITLE}
            </p>

            <div className={`lp-fade-up flex flex-wrap items-center gap-3`} style={delay(300)}>
              <a
                href="#pilot"
                className={`lp-press inline-flex min-h-12 items-center gap-2 rounded-full bg-teal-700 px-7 py-3 font-semibold text-white shadow-lg shadow-teal-700/25 hover:bg-teal-800 hover:shadow-xl hover:shadow-teal-700/30 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-600/40`}
              >
                Join the pilot
                <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                  <path
                    fillRule="evenodd"
                    d="M3 10a.75.75 0 0 1 .75-.75h10.6l-3.9-3.7a.75.75 0 1 1 1.04-1.08l5.25 5a.75.75 0 0 1 0 1.08l-5.25 5a.75.75 0 1 1-1.04-1.08l3.9-3.7H3.75A.75.75 0 0 1 3 10Z"
                    clipRule="evenodd"
                  />
                </svg>
              </a>
              <Link
                href="/dashboard"
                className={`lp-press inline-flex min-h-12 items-center rounded-full border border-slate-300 bg-white/80 px-7 py-3 font-semibold text-slate-800 backdrop-blur hover:border-teal-600 hover:text-teal-800 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-600/30`}
              >
                Open the demo
              </Link>
            </div>
          </div>

          <div className="lp-fade-up" style={delay(350)}>
            <HeroVisual />
          </div>
        </div>
      </section>

      {/* STATS */}
      <section className="border-y border-slate-200/70 bg-white">
        <div className="mx-auto grid w-full max-w-6xl gap-6 px-4 py-10 sm:grid-cols-3">
          {STATS.map((s, i) => (
            <Reveal key={s.value} delay={i * 100} className="flex items-center gap-4">
              <span className="text-4xl font-extrabold tabular-nums text-teal-700">{s.value}</span>
              <span className="text-sm leading-snug text-slate-600">{s.label}</span>
            </Reveal>
          ))}
        </div>
      </section>

      {/* PHASES */}
      <section className="mx-auto w-full max-w-6xl px-4 py-20 sm:py-24">
        <Reveal className="mx-auto mb-12 max-w-2xl text-center">
          <p className="mb-3 text-sm font-semibold uppercase tracking-widest text-teal-700">How it works</p>
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">One thread, three moments of care</h2>
        </Reveal>
        <PhaseCards />
      </section>

      {/* PRINCIPLE */}
      <section className="relative overflow-hidden bg-slate-900 text-white">
        <div aria-hidden="true">
          <div
            className="lp-blob"
            style={{ width: 380, height: 380, top: -160, right: -80, background: "#0d9488", opacity: 0.35 }}
          />
          <div
            className="lp-blob"
            style={{ width: 300, height: 300, bottom: -160, left: -60, background: "#f97362", opacity: 0.25, animationDelay: "-8s" }}
          />
        </div>
        <div className="relative mx-auto w-full max-w-6xl px-4 py-20 sm:py-24">
          <Reveal className="mb-12 max-w-3xl">
            <p className="mb-4 text-sm font-semibold uppercase tracking-widest text-teal-300">Our principle</p>
            <p className="text-3xl font-bold leading-tight tracking-tight sm:text-5xl">
              AI documents, the clinician decides.
            </p>
          </Reveal>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {TRUST.map((t, i) => (
              <Reveal
                key={t.title}
                delay={i * 90}
                className="rounded-2xl border border-white/10 bg-white/5 p-5 backdrop-blur"
              >
                <p className="mb-1.5 font-semibold text-teal-200">{t.title}</p>
                <p className="text-sm leading-relaxed text-slate-300">{t.text}</p>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* PILOT */}
      <section id="pilot" className="relative scroll-mt-6 overflow-hidden">
        <div aria-hidden="true">
          <div
            className="lp-blob"
            style={{ width: 340, height: 340, top: 40, left: -160, background: "#ccfbf1", animationDelay: "-3s" }}
          />
        </div>
        <div className="relative mx-auto grid w-full max-w-6xl gap-12 px-4 py-20 sm:py-24 lg:grid-cols-[1fr_1.1fr]">
          {/* No scroll reveal here: the sign-up must be visible even before JS runs or on /#pilot. */}
          <div>
            <p className="mb-3 text-sm font-semibold uppercase tracking-widest text-teal-700">Pilot programme</p>
            <h2 className="mb-4 text-3xl font-bold tracking-tight sm:text-4xl">Join the pilot</h2>
            <p className="mb-6 text-lg leading-relaxed text-slate-600">
              For early intervention therapists, child psychologists, centres and parents.
            </p>

            <div className="mb-8 rounded-2xl border border-amber-200 bg-gradient-to-br from-amber-50 to-orange-50 p-5">
              <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-amber-800">Pricing</p>
              <p className="font-semibold text-slate-900">
                Pilot pricing: Rs 3,000 (India) / EUR 199 (Germany) per clinician per month
              </p>
            </div>

            <ul className="space-y-3">
              {PILOT_PERKS.map((p) => (
                <li key={p} className="flex gap-3 text-slate-700">
                  <Check />
                  {p}
                </li>
              ))}
            </ul>
          </div>

          <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-xl shadow-slate-900/5 sm:p-8">
            <PilotForm />
          </div>
        </div>
      </section>
    </div>
  );
}
