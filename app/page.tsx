import type { Metadata } from "next";
import Image from "next/image";
import briefFixture from "@/demo/fixtures/gemini/brief.json";
import "@/components/landing/landing.css";
import { Features, LanguageRow } from "@/components/landing/Features";
import { fontVars } from "@/components/landing/fonts";
import { HeroReel } from "@/components/landing/HeroReel";
import { HowItWorks } from "@/components/landing/HowItWorks";
import { LoopVideo } from "@/components/landing/LoopVideo";
import { Reveal } from "@/components/landing/Reveal";
import { SiteFooter } from "@/components/landing/SiteFooter";
import { SiteNav } from "@/components/landing/SiteNav";
import { TherapistView } from "@/components/landing/TherapistView";
import { Arrow, ButtonLink, CheckIcon, Eyebrow } from "@/components/landing/ui";
import { VoiceDemo } from "@/components/landing/VoiceDemo";
import { BriefSchema } from "@/lib/types";

// The brief the sample intake call turns into (synthetic, validated at build time).
const SAMPLE_BRIEF = BriefSchema.parse(briefFixture);

const SUBTITLE =
  "CareThread is the AI assistant for early intervention therapists. It talks to the parent before the first session, documents the online session and fills the assessment form, and hands the complete case to the specialist.";

export const metadata: Metadata = {
  title: "CareThread - AI assistant for early intervention therapists",
  description: "CareThread is the AI assistant for early intervention therapists.",
};

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
    who: "The therapist",
    tag: "Uses it every day",
    pain: "Fills a 40-item form while watching the child. Writes reports after hours.",
    gain: "Arrives with a brief. The form fills itself, she confirms every item.",
    icon: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 8a7 7 0 0 1 14 0",
    featured: true,
  },
  {
    who: "The centre",
    tag: "Subscribes: one plan per clinician",
    pain: "Therapist burnout and churn. Records differ from centre to centre.",
    gain: "More assessments per therapist and one standard, evidence-backed record with an audit log.",
    icon: "M3 21h18M5 21V7l7-4 7 4v14M9 21v-6h6v6",
  },
  {
    who: "The family",
    tag: "Free, by invitation",
    pain: "Months on a waitlist. Explaining everything in a second language.",
    gain: "An intake call in Telugu, Hindi or English and a voice summary in their language.",
    icon: "M4 6h16v10H8l-4 4V6Z",
  },
  {
    who: "The specialist",
    tag: "Free, by link",
    pain: "Thin referral letters. Takes the full history again.",
    gain: "A referral packet with evidence, and answers from the case with timestamps.",
    icon: "M9 12l2 2 4-4M7 3h7l5 5v13H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z",
  },
];

const TRUST = [
  { title: "Consent first", text: "Parents agree before any call or recording starts." },
  { title: "Evidence on every item", text: "Each suggestion links to the exact moment in the session." },
  { title: "The clinician confirms", text: "Nothing reaches the report until the therapist confirms or edits it." },
  { title: "Private by design", text: "Private storage and an audit log of every change and decision." },
];

const FAQ = [
  {
    q: "Who uses CareThread?",
    a: "Early intervention therapists and child psychologists use it every day. Centres subscribe for their team. Parents and specialists never need an account: they get a link from the therapist.",
  },
  {
    q: "Who makes the clinical decision?",
    a: "Always the clinician. CareThread is not a diagnosis. It documents what was said and suggests ratings with evidence. The clinician reviews, edits and decides every item.",
  },
  {
    q: "What happens in the AI intake call?",
    a: "Before session 1 the parent opens a private link and talks to the CareThread assistant in Telugu, Hindi or English. It asks for consent first, then one question at a time. The therapist receives the recording and a pre-session brief with the parent's own words.",
  },
  {
    q: "Which assessments does it support?",
    a: "The ISAA (Indian Scale for Assessment of Autism), all 40 items, with an evidence quote and timestamp for each suggestion.",
  },
  {
    q: "Which languages can parents use?",
    a: "English, Hindi and Telugu today. German is coming soon. Reports are written in English.",
  },
  {
    q: "How do I get access?",
    a: "Book a demo. We walk you through CareThread on a sample case, then set up your centre's workspace and send your team their logins.",
  },
];

export default function Home() {
  return (
    <div className={`lp-root ${fontVars} overflow-x-clip`}>
      <SiteNav overDark />

      <HeroReel subtitle={SUBTITLE} />

      {/* ---------- THE PROBLEM ---------- */}
      <section id="problem" className="scroll-mt-20 bg-white">
        <div className="mx-auto w-full max-w-6xl px-4 py-24 sm:px-6 sm:py-32">
          <Reveal className="mb-14 max-w-3xl">
            <p className="mb-4 text-xs font-semibold uppercase tracking-[0.18em] text-[#c2410c]">The problem</p>
            <h2 className="lp-display text-5xl leading-[1.05] text-[#0b1f1d] sm:text-6xl">
              The signs appear at 2. <em className="text-[#c2410c]">Help arrives at 4 to 6.</em>
            </h2>
          </Reveal>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {PROBLEM_STATS.map((st, i) => (
              <Reveal
                key={st.value}
                delay={i * 80}
                className={`lp-card rounded-3xl p-6 ${
                  st.tone === "warm"
                    ? "bg-[#fff1e8] ring-1 ring-[#ef6f5e]/25"
                    : st.tone === "teal"
                      ? "bg-teal-50 ring-1 ring-teal-200"
                      : "bg-[#f8f6f1] ring-1 ring-[#0b1f1d]/[0.06]"
                }`}
              >
                <p
                  className={`lp-display mb-3 text-5xl leading-none ${
                    st.tone === "warm" ? "text-[#c2410c]" : st.tone === "teal" ? "text-teal-700" : "text-[#0b1f1d]"
                  }`}
                >
                  {st.value}
                </p>
                <p className="text-sm leading-relaxed text-slate-600">{st.label}</p>
              </Reveal>
            ))}
          </div>

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            {PREVALENCE.map((st, i) => (
              <Reveal key={st.value} delay={i * 80} className="flex items-baseline gap-5 rounded-3xl bg-[#0b1f1d] p-6 text-white">
                <span className="lp-display text-4xl text-[#fdba74]">{st.value}</span>
                <span className="text-sm text-white/70">{st.label}</span>
              </Reveal>
            ))}
          </div>

          <Reveal className="mt-10 grid gap-6 lg:grid-cols-[1fr_auto] lg:items-end">
            <p className="max-w-3xl text-xl leading-relaxed text-slate-700">
              <strong className="font-semibold text-[#0b1f1d]">Why so late?</strong> Too few specialists, year-long
              waitlists, and therapists who spend their sessions on paperwork.
            </p>
            <p className="text-xs text-slate-500">Sources: CDC ADDM 2025 · WHO · Höfer et al. 2019</p>
          </Reveal>
        </div>
      </section>

      {/* ---------- STEP 1: THE AI INTAKE CALL ---------- */}
      <section id="voice-demo" className="relative scroll-mt-20 overflow-hidden">
        <div aria-hidden="true" className="pointer-events-none absolute -right-48 top-24 h-[520px] w-[520px] rounded-full bg-teal-200/40 blur-[120px]" />
        <div className="relative mx-auto w-full max-w-6xl px-4 py-24 sm:px-6 sm:py-32">
          <Reveal className="mb-14 max-w-3xl">
            <Eyebrow>Step 1 · The AI intake call</Eyebrow>
            <h2 className="lp-display text-5xl leading-[1.05] text-[#0b1f1d] sm:text-6xl">
              Hear how CareThread <em className="text-teal-700">talks to parents.</em>
            </h2>
            <p className="mt-5 max-w-2xl text-lg leading-relaxed text-slate-600">
              Before the first visit, the family talks to the CareThread intake assistant, built on ElevenLabs, in their
              own language. The therapist walks into session 1 already knowing the history, so the session goes to the
              child.
            </p>
          </Reveal>

          <div className="grid items-start gap-12 lg:grid-cols-[0.9fr_1.15fr]">
            <ol className="relative space-y-7 before:absolute before:bottom-4 before:left-[19px] before:top-4 before:w-px before:bg-teal-700/20">
              {CALL_STEPS.map((step, i) => (
                <Reveal key={step.title} delay={i * 80} as="li" className="relative flex gap-5">
                  <span className="relative z-10 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#0b1f1d] text-sm font-semibold text-white ring-4 ring-[#f8f6f1]">
                    {i + 1}
                  </span>
                  <div className="pt-1.5">
                    <p className="text-lg font-semibold text-[#0b1f1d]">{step.title}</p>
                    <p className="mt-1 leading-relaxed text-slate-600">{step.text}</p>
                  </div>
                </Reveal>
              ))}
            </ol>
            <div className="lg:sticky lg:top-24">
              <VoiceDemo />
            </div>
          </div>

          {/* After the call */}
          <div className="mt-24 sm:mt-28">
            <Reveal className="mb-10 grid gap-6 lg:grid-cols-2 lg:items-end">
              <div>
                <Eyebrow>After the call</Eyebrow>
                <h3 className="lp-display text-4xl leading-[1.05] text-[#0b1f1d] sm:text-5xl">
                  What the therapist sees <em className="text-teal-700">before session 1.</em>
                </h3>
              </div>
              <p className="max-w-lg text-lg leading-relaxed text-slate-600 lg:justify-self-end">
                The recording, every answer in the parent&apos;s own words, red flags you can replay, and the questions
                to check in session 1. The therapist confirms each answer.
              </p>
            </Reveal>
            <TherapistView brief={SAMPLE_BRIEF} />
          </div>
        </div>
      </section>

      {/* ---------- THE SOLUTION / HOW IT WORKS ---------- */}
      <section id="how" className="scroll-mt-20 bg-white">
        <div className="mx-auto w-full max-w-6xl px-4 py-24 sm:px-6 sm:py-32">
          <Reveal className="mb-12 grid gap-8 lg:grid-cols-[1.1fr_1fr] lg:items-end">
            <div>
              <Eyebrow>The solution</Eyebrow>
              <h2 className="lp-display text-5xl leading-[1.05] text-[#0b1f1d] sm:text-6xl">
                One thread, from the first call <em className="text-teal-700">to the specialist.</em>
              </h2>
              <div className="mt-6">
                <LanguageRow />
              </div>
            </div>
            <div className="grid gap-3">
              {EVIDENCE.map((e) => (
                <div key={e.value} className="flex items-center gap-5 rounded-2xl bg-teal-50 p-5 ring-1 ring-teal-100">
                  <span className="lp-display shrink-0 text-4xl text-teal-700">{e.value}</span>
                  <span className="text-sm leading-relaxed text-slate-700">{e.label}</span>
                </div>
              ))}
              <p className="text-xs text-slate-500">Sources: Harstad et al., JAMA Pediatrics 2023 · Dawson et al., Pediatrics 2010</p>
            </div>
          </Reveal>
          <HowItWorks />
        </div>
      </section>

      {/* ---------- WHO IT'S FOR ---------- */}
      <section id="who" className="scroll-mt-20">
        <div className="mx-auto w-full max-w-6xl px-4 py-24 sm:px-6 sm:py-32">
          <Reveal className="mb-14 grid gap-6 lg:grid-cols-2 lg:items-end">
            <div>
              <Eyebrow>Who it&apos;s for</Eyebrow>
              <h2 className="lp-display text-5xl leading-[1.05] text-[#0b1f1d] sm:text-6xl">
                Built for therapists. <em className="text-teal-700">Simple for everyone around them.</em>
              </h2>
            </div>
            <p className="max-w-md text-lg leading-relaxed text-slate-600 lg:justify-self-end">
              Therapists log in and do the work. Centres subscribe. Families and specialists join free, by link.
            </p>
          </Reveal>

          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {AUDIENCES.map((a, i) => (
              <Reveal
                key={a.who}
                delay={i * 90}
                className={`lp-card relative flex flex-col rounded-3xl p-7 ${
                  a.featured ? "bg-[#0b1f1d] text-white" : "border border-[#0b1f1d]/[0.08] bg-white"
                }`}
              >
                <span
                  className={`mb-7 flex h-12 w-12 items-center justify-center rounded-2xl ${
                    a.featured ? "bg-teal-500/15 text-teal-300" : "bg-[#f8f6f1] text-teal-700"
                  }`}
                >
                  <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d={a.icon} />
                  </svg>
                </span>
                <h3 className="text-xl font-semibold">{a.who}</h3>
                <p className={`mb-5 text-sm font-medium ${a.featured ? "text-teal-300" : "text-teal-700"}`}>{a.tag}</p>
                <p className={`mb-1 text-[0.7rem] font-semibold uppercase tracking-wider ${a.featured ? "text-white/45" : "text-slate-400"}`}>Today</p>
                <p className={`mb-4 text-[0.92rem] leading-relaxed ${a.featured ? "text-white/70" : "text-slate-600"}`}>{a.pain}</p>
                <p className={`mb-1 text-[0.7rem] font-semibold uppercase tracking-wider ${a.featured ? "text-teal-300" : "text-teal-700"}`}>With CareThread</p>
                <p className={`text-[0.92rem] leading-relaxed ${a.featured ? "text-white" : "text-[#0b1f1d]"}`}>{a.gain}</p>
                {a.featured && (
                  <a href="/login" className="mt-6 inline-flex items-center gap-1.5 text-sm font-semibold text-white hover:text-teal-200">
                    Therapist log in <Arrow className="h-3.5 w-3.5" />
                  </a>
                )}
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ---------- FEATURES ---------- */}
      <section id="features" className="scroll-mt-20 bg-white">
        <div className="mx-auto w-full max-w-6xl px-4 py-24 sm:px-6 sm:py-32">
          <Reveal className="mb-14 max-w-2xl">
            <Eyebrow>Inside the workspace</Eyebrow>
            <h2 className="lp-display text-5xl leading-[1.05] text-[#0b1f1d] sm:text-6xl">
              Documentation you can <em className="text-teal-700">trust and check.</em>
            </h2>
          </Reveal>
          <Features />
        </div>
      </section>

      {/* ---------- PRINCIPLE / TRUST ---------- */}
      <section id="trust" className="relative scroll-mt-16 overflow-hidden bg-[#0b1f1d] text-white">
        <div className="absolute inset-0 overflow-hidden" aria-hidden="true">
          <Image src="/landing/room.jpg" alt="" fill sizes="100vw" className="lp-ken object-cover opacity-30" />
          <div className="absolute inset-0 bg-gradient-to-r from-[#0b1f1d] via-[#0b1f1d]/90 to-[#0b1f1d]/50" />
        </div>
        <div className="relative mx-auto w-full max-w-6xl px-4 py-28 sm:px-6 sm:py-36">
          <Reveal className="max-w-3xl">
            <Eyebrow tone="light">Our principle</Eyebrow>
            <p className="lp-display text-5xl leading-[1.04] sm:text-7xl">
              AI documents, <em className="text-teal-300">the clinician decides.</em>
            </p>
            <p className="mt-6 max-w-xl text-lg leading-relaxed text-white/70">
              CareThread does the writing. Every rating, every line of the report and every referral is checked and
              signed off by a person.
            </p>
          </Reveal>
          <div className="mt-16 grid gap-px overflow-hidden rounded-3xl bg-white/10 sm:grid-cols-2 lg:grid-cols-4">
            {TRUST.map((t, i) => (
              <Reveal key={t.title} delay={i * 90} className="bg-[#0b1f1d]/80 p-7 backdrop-blur">
                <CheckIcon className="mb-5 h-6 w-6 text-teal-300" />
                <p className="mb-2 font-semibold">{t.title}</p>
                <p className="text-sm leading-relaxed text-white/65">{t.text}</p>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ---------- FAQ ---------- */}
      <section id="faq" className="scroll-mt-20">
        <div className="mx-auto grid w-full max-w-6xl gap-12 px-4 py-24 sm:px-6 sm:py-32 lg:grid-cols-[0.8fr_1.2fr]">
          <Reveal>
            <Eyebrow>FAQ</Eyebrow>
            <h2 className="lp-display text-5xl leading-[1.05] text-[#0b1f1d] sm:text-6xl">Questions, answered.</h2>
            <p className="mt-5 max-w-sm text-slate-600">Something else on your mind? Ask us on the demo call.</p>
          </Reveal>
          <div className="divide-y divide-[#0b1f1d]/10 border-y border-[#0b1f1d]/10">
            {FAQ.map((f) => (
              <details key={f.q} className="lp-faq group">
                <summary className="flex min-h-16 cursor-pointer items-center justify-between gap-6 py-5 text-left text-lg font-semibold text-[#0b1f1d] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-600/30">
                  {f.q}
                  <span className="lp-chev flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white text-teal-700 ring-1 ring-[#0b1f1d]/10 group-hover:bg-teal-50">
                    <svg viewBox="0 0 20 20" className="h-4 w-4" fill="currentColor" aria-hidden="true">
                      <path d="M10 4a1 1 0 0 1 1 1v4h4a1 1 0 1 1 0 2h-4v4a1 1 0 1 1-2 0v-4H5a1 1 0 1 1 0-2h4V5a1 1 0 0 1 1-1Z" />
                    </svg>
                  </span>
                </summary>
                <p className="lp-faq-body max-w-2xl pb-6 leading-relaxed text-slate-600">{f.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* ---------- FINAL CTA ---------- */}
      <section id="pilot" className="scroll-mt-20 px-4 pb-24 sm:px-6">
        <Reveal className="relative mx-auto w-full max-w-6xl overflow-hidden rounded-[32px] bg-teal-800 text-white">
          <div className="absolute inset-0" aria-hidden="true">
            <LoopVideo src="/landing/hero.mp4" poster="/landing/hero.jpg" className="h-full w-full object-cover opacity-25 mix-blend-luminosity" />
            <div className="absolute inset-0 bg-gradient-to-r from-teal-900 via-teal-900/85 to-teal-800/40" />
          </div>
          <div className="relative grid gap-10 px-7 py-16 sm:px-14 sm:py-20 lg:grid-cols-[1.3fr_1fr] lg:items-center">
            <div>
              <Eyebrow tone="lighter">Now onboarding pilot centres in Germany and India</Eyebrow>
              <h2 className="lp-display text-5xl leading-[1.04] sm:text-6xl">
                Get kids into early intervention <em className="text-teal-200">sooner.</em>
              </h2>
              <p className="mt-5 max-w-lg text-lg leading-relaxed text-white/75">
                See CareThread on a sample case in a short call. If it fits, we set up your centre&apos;s workspace and
                send your team their logins.
              </p>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row lg:flex-col lg:items-stretch">
              <ButtonLink href="/book-demo" variant="light" className="min-h-14 text-base">
                Book a demo
                <Arrow />
              </ButtonLink>
              <ButtonLink href="/login" variant="outlineLight" className="min-h-14 text-base">
                Log in to your workspace
              </ButtonLink>
            </div>
          </div>
        </Reveal>
      </section>

      <SiteFooter />
    </div>
  );
}
