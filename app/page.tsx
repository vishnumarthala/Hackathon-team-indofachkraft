import type { CSSProperties } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import briefFixture from "@/demo/fixtures/gemini/brief.json";
import { HeroVisual } from "@/components/landing/HeroVisual";
import "@/components/landing/landing.css";
import { PhaseCards } from "@/components/landing/PhaseCards";
import { PilotForm } from "@/components/landing/PilotForm";
import { Reveal } from "@/components/landing/Reveal";
import { TherapistView } from "@/components/landing/TherapistView";
import { VoiceDemo } from "@/components/landing/VoiceDemo";
import { BriefSchema } from "@/lib/types";

// The demo brief the intake call turns into (synthetic, validated at build time).
const SAMPLE_BRIEF = BriefSchema.parse(briefFixture);

const SUBTITLE =
  "CareThread is the AI assistant for early intervention therapists. It talks to the parent before the first session, documents the online session and fills the assessment form, and hands the complete case to the specialist.";

export const metadata: Metadata = {
  title: "CareThread - AI assistant for early intervention therapists",
  description: "CareThread is the AI assistant for early intervention therapists.",
};

const delay = (ms: number) => ({ "--d": `${ms}ms` }) as CSSProperties;

const STATS = [
  { value: "40", label: "ISAA items, each with an evidence quote and timestamp" },
  { value: "3", label: "languages for the parent call: English, Hindi and Telugu (German coming soon)" },
  { value: "1", label: "thread from the first call to the specialist" },
];

const TRUST = [
  { title: "Consent first", text: "Parents agree before any call or recording starts." },
  { title: "Evidence on every item", text: "Each suggestion links to the exact moment in the session." },
  { title: "Clinician confirms", text: "Nothing reaches the report until the therapist confirms or edits it." },
  { title: "Privacy by design", text: "Private storage, an audit log of every change, and synthetic data only in this demo." },
];

const VALUE_LINE = "Get kids into early intervention sooner.";

// Pitch deck slide 1 (sources listed under the section).
const PROBLEM_STATS = [
  { value: "~2 years", label: "Parents notice the first signs (23 months on average)", tone: "warm" },
  { value: "Before 3", label: "The window: the younger support starts, the bigger the gains", tone: "teal" },
  { value: "4 years", label: "Median age at which US children are identified; only half are evaluated by age 3", tone: "plain" },
  { value: "6.5 years", label: "Average age at which German children are identified: after Kita, at school entry", tone: "plain" },
];

const PREVALENCE = [
  { value: "1 in 31", label: "US children have autism (1 in 20 boys)" },
  { value: "1 in 100", label: "children worldwide" },
];

// Pitch deck slide 2.
const EVIDENCE = [
  { value: "4 in 10", label: "toddlers identified with autism at 1 to 3 years no longer met the criteria at age 5 to 7" },
  { value: "+17.6 vs +7", label: "IQ points after 2 years of early intervention vs usual care (randomised trial)" },
];

const CALL_STEPS = [
  { title: "A link, not a waiting room", text: "After booking, the parent gets a private link by WhatsApp or email and opens it on their phone." },
  { title: "Consent first", text: "The assistant says it is an AI, that the call is recorded for the therapist, and asks before it continues." },
  { title: "In the parent's language", text: "Telugu, Hindi or English, one question at a time: speech, lost words, eye contact, play, sounds, routines, safety." },
  { title: "A brief for the therapist", text: "Red flags such as lost speech or self-injury are quoted in the parent's words. It documents; the therapist decides." },
];

const AUDIENCES = [
  {
    who: "The centre",
    tag: "Pays: one plan per clinician",
    pain: "Therapist burnout and churn. Records differ from centre to centre.",
    gain: "More assessments per therapist and one standard, evidence-backed record with an audit log.",
  },
  {
    who: "The therapist",
    tag: "Uses it every day",
    pain: "Fills a 40-item form while watching the child. Writes reports after hours.",
    gain: "Arrives with a brief. The form fills itself, she confirms every item.",
  },
  {
    who: "The family",
    tag: "Free, by invitation",
    pain: "Months on a waitlist. Explaining everything in a second language.",
    gain: "An intake call in Telugu, Hindi or English and a voice summary in their language.",
  },
  {
    who: "The specialist",
    tag: "Free, by link",
    pain: "Thin referral letters. Takes the full history again.",
    gain: "A referral packet with evidence, and answers from the case with timestamps.",
  },
];

const PILOT_PERKS = [
  "For centres and clinicians: one pilot per centre",
  "Help shape the product with direct access to the team",
  "Parent calls in English, Hindi and Telugu (German coming soon)",
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
              Pilot open for centres in Germany and India
            </p>

            <h1
              className={`lp-fade-up mb-6 text-5xl font-extrabold tracking-tight sm:text-6xl lg:text-7xl`}
              style={delay(100)}
            >
              <span className="lp-gradient-text">CareThread</span>
            </h1>

            <p
              className={`lp-fade-up mb-4 max-w-xl text-xl font-semibold leading-snug text-slate-900 sm:text-2xl`}
              style={delay(150)}
            >
              {VALUE_LINE}
            </p>

            <p
              className={`lp-fade-up mb-8 max-w-xl text-lg leading-relaxed text-slate-600 sm:text-xl`}
              style={delay(200)}
            >
              {SUBTITLE}
            </p>

            <div className={`lp-fade-up flex flex-wrap items-center gap-3`} style={delay(300)}>
              <a
                href="#voice-demo"
                className={`lp-press inline-flex min-h-12 items-center gap-2 rounded-full bg-slate-900 px-7 py-3 font-semibold text-white shadow-lg shadow-slate-900/20 hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-slate-500/40`}
              >
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <path strokeLinecap="round" d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3ZM19 11a7 7 0 0 1-14 0M12 18v3" />
                </svg>
                Hear the AI intake call
              </a>
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

      {/* PROBLEM */}
      <section className="border-y border-slate-200/70 bg-white">
        <div className="mx-auto w-full max-w-6xl px-4 py-20 sm:py-24">
          <Reveal className="mb-10 max-w-3xl">
            <p className="mb-3 text-sm font-semibold uppercase tracking-widest text-orange-700">The problem</p>
            <h2 className="text-3xl font-bold tracking-tight sm:text-5xl">The signs appear at 2. Help arrives at 4 to 6.</h2>
          </Reveal>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {PROBLEM_STATS.map((st, i) => (
              <Reveal
                key={st.value}
                delay={i * 80}
                className={`rounded-2xl border-t-4 p-5 shadow-sm ${
                  st.tone === "warm"
                    ? "border-orange-500 bg-[#fbfaf7]"
                    : st.tone === "teal"
                      ? "border-teal-600 bg-teal-50"
                      : "border-slate-800 bg-[#fbfaf7]"
                }`}
              >
                <p className={`mb-2 text-3xl font-extrabold ${st.tone === "warm" ? "text-orange-700" : st.tone === "teal" ? "text-teal-700" : "text-slate-900"}`}>
                  {st.value}
                </p>
                <p className="text-sm leading-relaxed text-slate-600">{st.label}</p>
              </Reveal>
            ))}
          </div>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            {PREVALENCE.map((st, i) => (
              <Reveal key={st.value} delay={i * 80} className="flex items-baseline gap-4 rounded-2xl bg-slate-900 p-5 text-white">
                <span className="text-3xl font-extrabold text-orange-300">{st.value}</span>
                <span className="text-sm text-slate-300">{st.label}</span>
              </Reveal>
            ))}
          </div>
          <p className="mt-6 max-w-3xl text-lg text-slate-700">
            <strong className="text-slate-900">Why so late?</strong> Too few specialists, year-long waitlists, and
            therapists who spend their sessions on paperwork.
          </p>
          <p className="mt-3 text-xs text-slate-500">Sources: CDC ADDM 2025 · WHO · Höfer et al. 2019</p>
        </div>
      </section>

      {/* VOICE DEMO */}
      <section id="voice-demo" className="relative scroll-mt-6 overflow-hidden">
        <div aria-hidden="true">
          <div className="lp-blob" style={{ width: 360, height: 360, top: 60, right: -160, background: "#ccfbf1", animationDelay: "-4s" }} />
        </div>
        <div className="relative mx-auto w-full max-w-6xl px-4 py-20 sm:py-24">
          <Reveal className="mb-12 max-w-3xl">
            <p className="mb-3 text-sm font-semibold uppercase tracking-widest text-teal-700">
              Step 1 · The AI intake call
            </p>
            <h2 className="mb-4 text-3xl font-bold tracking-tight sm:text-4xl">
              Hear how our ElevenLabs voice agent talks to parents
            </h2>
            <p className="text-lg leading-relaxed text-slate-600">
              Before the first visit, the family talks to the CareThread intake assistant in their own language. The
              therapist walks into session 1 already knowing the history, so the session goes to the child.
            </p>
          </Reveal>
          <div className="grid items-start gap-10 lg:grid-cols-[1fr_1.15fr]">
            <ol className="space-y-5">
              {CALL_STEPS.map((step, i) => (
                <Reveal key={step.title} delay={i * 80} className="flex gap-4">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-teal-700 text-sm font-bold text-white">
                    {i + 1}
                  </span>
                  <div>
                    <p className="font-semibold text-slate-900">{step.title}</p>
                    <p className="text-sm leading-relaxed text-slate-600">{step.text}</p>
                  </div>
                </Reveal>
              ))}
            </ol>
            <VoiceDemo />
          </div>
          <div className="mt-16">
            <Reveal className="mb-6 max-w-3xl">
              <p className="mb-2 text-sm font-semibold uppercase tracking-widest text-teal-700">After the call</p>
              <h3 className="text-2xl font-bold tracking-tight sm:text-3xl">What the therapist sees after the call</h3>
              <p className="mt-2 text-slate-600">
                The recording, every answer with the parent&apos;s own words, red flags you can replay, and the
                questions to check in session 1. The therapist confirms each answer.
              </p>
            </Reveal>
            <TherapistView brief={SAMPLE_BRIEF} />
          </div>
        </div>
      </section>

      {/* SOLUTION / PHASES */}
      <section className="border-y border-slate-200/70 bg-white">
        <div className="mx-auto w-full max-w-6xl px-4 py-20 sm:py-24">
          <Reveal className="mx-auto mb-10 max-w-2xl text-center">
            <p className="mb-3 text-sm font-semibold uppercase tracking-widest text-teal-700">The solution</p>
            <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">One thread, three moments of care</h2>
          </Reveal>
          <div className="mb-10 grid gap-4 md:grid-cols-2">
            {EVIDENCE.map((e, i) => (
              <Reveal key={e.value} delay={i * 80} className="flex items-center gap-5 rounded-2xl bg-teal-50 p-5">
                <span className="shrink-0 text-3xl font-extrabold text-teal-700 sm:text-4xl">{e.value}</span>
                <span className="text-sm leading-relaxed text-slate-700">{e.label}</span>
              </Reveal>
            ))}
          </div>
          <PhaseCards />
          <div className="mt-12 grid gap-6 sm:grid-cols-3">
            {STATS.map((st, i) => (
              <Reveal key={st.value} delay={i * 100} className="flex items-center gap-4">
                <span className="text-4xl font-extrabold tabular-nums text-teal-700">{st.value}</span>
                <span className="text-sm leading-snug text-slate-600">{st.label}</span>
              </Reveal>
            ))}
          </div>
          <p className="mt-8 text-center text-xs text-slate-500">
            Sources: Harstad et al., JAMA Pediatrics 2023 · Dawson et al., Pediatrics 2010
          </p>
        </div>
      </section>

      {/* WHO IT'S FOR */}
      <section className="mx-auto w-full max-w-6xl px-4 py-20 sm:py-24">
        <Reveal className="mx-auto mb-12 max-w-2xl text-center">
          <p className="mb-3 text-sm font-semibold uppercase tracking-widest text-teal-700">Who it&apos;s for</p>
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">Four people, one thread</h2>
          <p className="mt-3 text-slate-600">Centres subscribe. Therapists use it every day. Families and specialists join free.</p>
        </Reveal>
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {AUDIENCES.map((a, i) => (
            <Reveal
              key={a.who}
              delay={i * 90}
              className={`flex flex-col rounded-2xl border p-6 ${i === 0 ? "border-teal-300 bg-teal-50/60" : "border-slate-200 bg-white"}`}
            >
              <h3 className="text-lg font-bold text-slate-900">{a.who}</h3>
              <p className="mb-4 text-sm font-medium text-teal-800">{a.tag}</p>
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Today</p>
              <p className="mb-4 text-sm leading-relaxed text-slate-700">{a.pain}</p>
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-teal-700">With CareThread</p>
              <p className="text-sm leading-relaxed text-slate-800">{a.gain}</p>
            </Reveal>
          ))}
        </div>
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
            <p className="mb-2 text-lg leading-relaxed text-slate-600">
              For early intervention centres, therapists and child psychologists.
            </p>
            <p className="mb-6 text-sm text-slate-500">
              Parent? You don&apos;t need to sign up: your therapist sends you a link.
            </p>

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

      <footer className="border-t border-slate-200/70 py-8 text-center text-sm text-slate-500">
        Built on ElevenLabs and Google Gemini · Synthetic demo data only · AI documents, the clinician decides.
      </footer>
    </div>
  );
}
