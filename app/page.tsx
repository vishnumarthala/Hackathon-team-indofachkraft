import type { Metadata } from "next";
import Image from "next/image";
import "@/components/landing/landing.css";
import { Features, LanguageRow } from "@/components/landing/Features";
import { fontVars } from "@/components/landing/fonts";
import { HeroReel } from "@/components/landing/HeroReel";
import { HowItWorks } from "@/components/landing/HowItWorks";
import { LoopVideo } from "@/components/landing/LoopVideo";
import { Reveal } from "@/components/landing/Reveal";
import { SiteFooter } from "@/components/landing/SiteFooter";
import { SiteNav } from "@/components/landing/SiteNav";
import { Arrow, ButtonLink, CheckIcon, Eyebrow } from "@/components/landing/ui";
import roomImage from "@/public/landing/room.jpg";

const SUBTITLE =
  "CareThread is the AI assistant for early intervention therapists. It talks to the parent before the first session, documents the online session and fills the assessment form, and hands the complete case to the specialist.";

export const metadata: Metadata = {
  title: "CareThread - AI assistant for early intervention therapists",
  description: "CareThread is the AI assistant for early intervention therapists.",
};

const AUDIENCES = [
  {
    who: "Therapists",
    tag: "Use it every day",
    text: "Your workspace. Brief before session 1, ISAA filled from the session, a draft report you confirm.",
    icon: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 8a7 7 0 0 1 14 0",
    featured: true,
  },
  {
    who: "Centres",
    tag: "Subscribe for their team",
    text: "Consistent, evidence-backed ISAA records across every therapist, with an audit log of every change.",
    icon: "M3 21h18M5 21V7l7-4 7 4v14M9 21v-6h6v6",
  },
  {
    who: "Parents",
    tag: "Free, by invitation",
    text: "A link from their therapist. They talk in their own language before the first session. No app, no account.",
    icon: "M4 6h16v10H8l-4 4V6Z",
  },
  {
    who: "Specialists",
    tag: "Free, by link",
    text: "Receive the complete referral packet and ask the case questions. Every answer cites its source.",
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
  {
    q: "I already have an account. Where do I log in?",
    a: "Use Log in at the top of this page with the email and password from your centre's administrator.",
  },
];

export default function Home() {
  return (
    <div className={`lp-root ${fontVars} overflow-x-clip`}>
      <SiteNav overDark />

      <HeroReel subtitle={SUBTITLE} />

      {/* ---------- PROOF STRIP ---------- */}
      <section className="border-y border-[#0b1f1d]/[0.07] bg-white">
        <div className="mx-auto grid w-full max-w-6xl grid-cols-1 divide-y divide-[#0b1f1d]/[0.07] px-4 sm:grid-cols-3 sm:divide-x sm:divide-y-0 sm:px-6">
          {[
            { v: "40", l: "ISAA items, each with a quote and timestamp" },
            { v: "1", l: "thread from the first parent call to the specialist" },
            { v: "0", l: "ratings final until the therapist confirms them" },
          ].map((s, i) => (
            <Reveal key={s.l} delay={i * 90} className="flex items-center gap-5 py-8 sm:justify-center sm:px-6">
              <span className="lp-display text-6xl leading-none text-teal-700">{s.v}</span>
              <span className="max-w-[14rem] text-sm leading-snug text-slate-600">{s.l}</span>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ---------- HOW IT WORKS ---------- */}
      <section id="how" className="scroll-mt-20">
        <div className="mx-auto w-full max-w-6xl px-4 py-24 sm:px-6 sm:py-32">
          <Reveal className="mb-14 max-w-2xl">
            <Eyebrow>How it works</Eyebrow>
            <h2 className="lp-display text-5xl leading-[1.05] text-[#0b1f1d] sm:text-6xl">
              One thread, from the first call <em className="text-teal-700">to the specialist.</em>
            </h2>
            <div className="mt-6">
              <LanguageRow />
            </div>
          </Reveal>
          <HowItWorks />
        </div>
      </section>

      {/* ---------- WHO IT'S FOR ---------- */}
      <section id="who" className="scroll-mt-20 bg-white">
        <div className="mx-auto w-full max-w-6xl px-4 py-24 sm:px-6 sm:py-32">
          <Reveal className="mb-14 grid gap-6 lg:grid-cols-2 lg:items-end">
            <div>
              <Eyebrow>Who it&apos;s for</Eyebrow>
              <h2 className="lp-display text-5xl leading-[1.05] text-[#0b1f1d] sm:text-6xl">
                Built for therapists. <em className="text-teal-700">Simple for everyone around them.</em>
              </h2>
            </div>
            <p className="max-w-md text-lg leading-relaxed text-slate-600 lg:justify-self-end">
              Therapists log in and do the work. Parents and specialists join by link, with nothing to install.
            </p>
          </Reveal>

          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {AUDIENCES.map((a, i) => (
              <Reveal
                key={a.who}
                delay={i * 90}
                className={`lp-card relative flex flex-col rounded-3xl p-7 ${
                  a.featured ? "bg-[#0b1f1d] text-white" : "border border-[#0b1f1d]/[0.08] bg-[#f8f6f1]"
                }`}
              >
                <span
                  className={`mb-8 flex h-12 w-12 items-center justify-center rounded-2xl ${
                    a.featured ? "bg-teal-500/15 text-teal-300" : "bg-white text-teal-700 ring-1 ring-[#0b1f1d]/[0.06]"
                  }`}
                >
                  <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d={a.icon} />
                  </svg>
                </span>
                <h3 className="text-xl font-semibold">{a.who}</h3>
                <p className={`mb-3 text-sm font-medium ${a.featured ? "text-teal-300" : "text-teal-700"}`}>{a.tag}</p>
                <p className={`text-[0.95rem] leading-relaxed ${a.featured ? "text-white/70" : "text-slate-600"}`}>{a.text}</p>
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
      <section id="features" className="scroll-mt-20">
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
          <Image src={roomImage} alt="" fill sizes="100vw" className="lp-ken object-cover opacity-30" placeholder="blur" />
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
            <p className="mt-5 max-w-sm text-slate-600">
              Something else on your mind? Ask us on the demo call.
            </p>
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
                Give your therapists their <em className="text-teal-200">sessions back.</em>
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
