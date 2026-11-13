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
import { getT } from "@/lib/i18n/server";
import { BriefSchema } from "@/lib/types";
import roomImage from "@/public/landing/room.jpg";

// The brief the sample intake call turns into (synthetic, validated at build time). AI output: not translated.
const SAMPLE_BRIEF = BriefSchema.parse(briefFixture);

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT("landing.meta");
  return { title: t("title"), description: t("description") };
}

const PROBLEM_TONES = ["warm", "teal", "plain", "plain"] as const;

const AUDIENCE_ICONS = {
  therapist: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 8a7 7 0 0 1 14 0",
  centre: "M3 21h18M5 21V7l7-4 7 4v14M9 21v-6h6v6",
  family: "M4 6h16v10H8l-4 4V6Z",
  specialist: "M9 12l2 2 4-4M7 3h7l5 5v13H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z",
} as const;

export default async function Home() {
  const t = await getT("landing");
  const ts = await getT("screen.landing");

  // Pitch deck slide 1 (sources listed under the section).
  const problemStats = ([1, 2, 3, 4] as const).map((n, i) => ({
    value: t(`problem.stat${n}Value`),
    label: t(`problem.stat${n}Label`),
    tone: PROBLEM_TONES[i],
  }));
  const prevalence = ([1, 2] as const).map((n) => ({
    value: t(`problem.prevalence${n}Value`),
    label: t(`problem.prevalence${n}Label`),
  }));
  // Pitch deck slide 2.
  const evidence = ([1, 2] as const).map((n) => ({
    value: t(`solution.evidence${n}Value`),
    label: t(`solution.evidence${n}Label`),
  }));
  const callSteps = ([1, 2, 3, 4] as const).map((n) => ({
    title: t(`voice.step${n}Title`),
    text: t(`voice.step${n}Text`),
  }));
  const audiences = (["therapist", "centre", "family", "specialist"] as const).map((key) => ({
    key,
    who: t(`who.${key}Who`),
    tag: t(`who.${key}Tag`),
    pain: t(`who.${key}Pain`),
    gain: t(`who.${key}Gain`),
    icon: AUDIENCE_ICONS[key],
    featured: key === "therapist",
  }));
  const trust = (["consent", "evidence", "clinician", "private"] as const).map((key) => ({
    title: t(`trust.${key}Title`),
    text: t(`trust.${key}Text`),
  }));
  const faq = ([1, 2, 3, 4, 5, 6] as const).map((n) => ({ q: t(`faq.q${n}`), a: t(`faq.a${n}`) }));

  return (
    <div className={`lp-root ${fontVars} overflow-x-clip`}>
      <SiteNav overDark />

      <HeroReel subtitle={t("hero.subtitle")} />

      {/* ---------- THE PROBLEM ---------- */}
      <section id="problem" className="scroll-mt-20 bg-white">
        <div className="mx-auto w-full max-w-6xl px-4 py-24 sm:px-6 sm:py-32">
          <Reveal className="mb-14 max-w-3xl">
            <p className="mb-4 text-xs font-semibold uppercase tracking-[0.18em] text-[#c2410c]">{t("problem.eyebrow")}</p>
            <h2 className="lp-display text-5xl leading-[1.05] text-[#0b1f1d] sm:text-6xl">
              {t("problem.title")} <em className="text-[#c2410c]">{t("problem.titleEm")}</em>
            </h2>
          </Reveal>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {problemStats.map((st, i) => (
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
            {prevalence.map((st, i) => (
              <Reveal key={st.value} delay={i * 80} className="flex items-baseline gap-5 rounded-3xl bg-[#0b1f1d] p-6 text-white">
                <span className="lp-display text-4xl text-[#fdba74]">{st.value}</span>
                <span className="text-sm text-white/70">{st.label}</span>
              </Reveal>
            ))}
          </div>

          <Reveal className="mt-10 grid gap-6 lg:grid-cols-[1fr_auto] lg:items-end">
            <p className="max-w-3xl text-xl leading-relaxed text-slate-700">
              <strong className="font-semibold text-[#0b1f1d]">{t("problem.whyLate")}</strong> {t("problem.whyLateText")}
            </p>
            <p className="text-xs text-slate-500">{t("problem.sources")}</p>
          </Reveal>
        </div>
      </section>

      {/* ---------- 033: PARENT DEVELOPMENTAL CHECK-IN ---------- */}
      <section id="check-in" aria-labelledby="check-in-title" className="scroll-mt-20 bg-white px-4 pb-16 sm:px-6">
        <Reveal className="mx-auto grid w-full max-w-6xl gap-6 rounded-3xl bg-teal-50 p-7 ring-1 ring-teal-200 sm:p-10 lg:grid-cols-[1.4fr_auto] lg:items-center">
          <div>
            <Eyebrow>{ts("eyebrow")}</Eyebrow>
            <h2 id="check-in-title" className="lp-display text-4xl leading-[1.05] text-[#0b1f1d] sm:text-5xl">
              {ts("title")}
            </h2>
            <p className="mt-4 max-w-2xl text-lg leading-relaxed text-slate-700">{ts("text")}</p>
          </div>
          <ButtonLink href="/screen" className="min-h-14 text-base">
            {ts("cta")}
            <Arrow />
          </ButtonLink>
        </Reveal>
      </section>

      {/* ---------- STEP 1: THE AI INTAKE CALL ---------- */}
      <section id="voice-demo" className="relative scroll-mt-20 overflow-hidden">
        <div aria-hidden="true" className="pointer-events-none absolute -right-48 top-24 h-[520px] w-[520px] rounded-full bg-teal-200/40 blur-[120px]" />
        <div className="relative mx-auto w-full max-w-6xl px-4 py-24 sm:px-6 sm:py-32">
          <Reveal className="mb-14 max-w-3xl">
            <Eyebrow>{t("voice.eyebrow")}</Eyebrow>
            <h2 className="lp-display text-5xl leading-[1.05] text-[#0b1f1d] sm:text-6xl">
              {t("voice.title")} <em className="text-teal-700">{t("voice.titleEm")}</em>
            </h2>
            <p className="mt-5 max-w-2xl text-lg leading-relaxed text-slate-600">
              {t("voice.intro")}
            </p>
          </Reveal>

          <div className="grid items-start gap-12 lg:grid-cols-[0.9fr_1.15fr]">
            <ol className="relative space-y-7 before:absolute before:bottom-4 before:left-[19px] before:top-4 before:w-px before:bg-teal-700/20">
              {callSteps.map((step, i) => (
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
                <Eyebrow>{t("voice.afterEyebrow")}</Eyebrow>
                <h3 className="lp-display text-4xl leading-[1.05] text-[#0b1f1d] sm:text-5xl">
                  {t("voice.afterTitle")} <em className="text-teal-700">{t("voice.afterTitleEm")}</em>
                </h3>
              </div>
              <p className="max-w-lg text-lg leading-relaxed text-slate-600 lg:justify-self-end">
                {t("voice.afterText")}
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
              <Eyebrow>{t("solution.eyebrow")}</Eyebrow>
              <h2 className="lp-display text-5xl leading-[1.05] text-[#0b1f1d] sm:text-6xl">
                {t("solution.title")} <em className="text-teal-700">{t("solution.titleEm")}</em>
              </h2>
              <div className="mt-6">
                <LanguageRow />
              </div>
            </div>
            <div className="grid gap-3">
              {evidence.map((e) => (
                <div key={e.value} className="flex items-center gap-5 rounded-2xl bg-teal-50 p-5 ring-1 ring-teal-100">
                  <span className="lp-display shrink-0 text-4xl text-teal-700">{e.value}</span>
                  <span className="text-sm leading-relaxed text-slate-700">{e.label}</span>
                </div>
              ))}
              <p className="text-xs text-slate-500">{t("solution.sources")}</p>
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
              <Eyebrow>{t("who.eyebrow")}</Eyebrow>
              <h2 className="lp-display text-5xl leading-[1.05] text-[#0b1f1d] sm:text-6xl">
                {t("who.title")} <em className="text-teal-700">{t("who.titleEm")}</em>
              </h2>
            </div>
            <p className="max-w-md text-lg leading-relaxed text-slate-600 lg:justify-self-end">
              {t("who.intro")}
            </p>
          </Reveal>

          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {audiences.map((a, i) => (
              <Reveal
                key={a.key}
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
                <p className={`mb-1 text-[0.7rem] font-semibold uppercase tracking-wider ${a.featured ? "text-white/45" : "text-slate-400"}`}>{t("who.today")}</p>
                <p className={`mb-4 text-[0.92rem] leading-relaxed ${a.featured ? "text-white/70" : "text-slate-600"}`}>{a.pain}</p>
                <p className={`mb-1 text-[0.7rem] font-semibold uppercase tracking-wider ${a.featured ? "text-teal-300" : "text-teal-700"}`}>{t("who.withUs")}</p>
                <p className={`text-[0.92rem] leading-relaxed ${a.featured ? "text-white" : "text-[#0b1f1d]"}`}>{a.gain}</p>
                {a.featured && (
                  <a href="/login" className="mt-6 inline-flex items-center gap-1.5 text-sm font-semibold text-white hover:text-teal-200">
                    {t("who.therapistLogin")} <Arrow className="h-3.5 w-3.5" />
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
            <Eyebrow>{t("features.eyebrow")}</Eyebrow>
            <h2 className="lp-display text-5xl leading-[1.05] text-[#0b1f1d] sm:text-6xl">
              {t("features.title")} <em className="text-teal-700">{t("features.titleEm")}</em>
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
            <Eyebrow tone="light">{t("trust.eyebrow")}</Eyebrow>
            <p className="lp-display text-5xl leading-[1.04] sm:text-7xl">
              {t("trust.title")} <em className="text-teal-300">{t("trust.titleEm")}</em>
            </p>
            <p className="mt-6 max-w-xl text-lg leading-relaxed text-white/70">
              {t("trust.intro")}
            </p>
          </Reveal>
          <div className="mt-16 grid gap-px overflow-hidden rounded-3xl bg-white/10 sm:grid-cols-2 lg:grid-cols-4">
            {trust.map((item, i) => (
              <Reveal key={item.title} delay={i * 90} className="bg-[#0b1f1d]/80 p-7 backdrop-blur">
                <CheckIcon className="mb-5 h-6 w-6 text-teal-300" />
                <p className="mb-2 font-semibold">{item.title}</p>
                <p className="text-sm leading-relaxed text-white/65">{item.text}</p>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ---------- FAQ ---------- */}
      <section id="faq" className="scroll-mt-20">
        <div className="mx-auto grid w-full max-w-6xl gap-12 px-4 py-24 sm:px-6 sm:py-32 lg:grid-cols-[0.8fr_1.2fr]">
          <Reveal>
            <Eyebrow>{t("faq.eyebrow")}</Eyebrow>
            <h2 className="lp-display text-5xl leading-[1.05] text-[#0b1f1d] sm:text-6xl">{t("faq.title")}</h2>
            <p className="mt-5 max-w-sm text-slate-600">{t("faq.intro")}</p>
          </Reveal>
          <div className="divide-y divide-[#0b1f1d]/10 border-y border-[#0b1f1d]/10">
            {faq.map((f) => (
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
              <Eyebrow tone="lighter">{t("cta.eyebrow")}</Eyebrow>
              <h2 className="lp-display text-5xl leading-[1.04] sm:text-6xl">
                {t("cta.title")} <em className="text-teal-200">{t("cta.titleEm")}</em>
              </h2>
              <p className="mt-5 max-w-lg text-lg leading-relaxed text-white/75">
                {t("cta.text")}
              </p>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row lg:flex-col lg:items-stretch">
              <ButtonLink href="/book-demo" variant="light" className="min-h-14 text-base">
                {t("cta.bookDemo")}
                <Arrow />
              </ButtonLink>
              <ButtonLink href="/login" variant="outlineLight" className="min-h-14 text-base">
                {t("cta.logIn")}
              </ButtonLink>
            </div>
          </div>
        </Reveal>
      </section>

      <SiteFooter />
    </div>
  );
}
