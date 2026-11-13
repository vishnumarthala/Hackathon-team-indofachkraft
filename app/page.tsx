import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import "@/components/landing/landing.css";
import { fontVars } from "@/components/landing/fonts";
import { IndianStats } from "@/components/landing/IndianStats";
import { PARENT_LINKS } from "@/components/landing/links";
import { Reveal } from "@/components/landing/Reveal";
import { SiteFooter } from "@/components/landing/SiteFooter";
import { SiteNav } from "@/components/landing/SiteNav";
import { Arrow, ButtonLink, CheckIcon, Eyebrow } from "@/components/landing/ui";
import { env } from "@/lib/env";
import { getT } from "@/lib/i18n/server";
import blocksImage from "@/public/landing/blocks.jpg";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT("landing.parents.meta");
  return {
    title: t("title"),
    description: t("description"),
    // The UI language is a cookie (ticket 018), not a URL, so there are no per-language URLs for hreflang alternates.
    alternates: { canonical: `${env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "")}/` },
  };
}

const STEP_ICONS = [
  // clipboard-check, map-pin, calendar, home
  "M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M9 5a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2M9 5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2m-6 9 2 2 4-4",
  "M12 21s-7-6.2-7-11a7 7 0 1 1 14 0c0 4.8-7 11-7 11Zm0-8.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z",
  "M8 2v4m8-4v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z",
  "M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1v-9.5Z",
] as const;

// 050: `/` is for parents (D-1); the therapist / centre landing lives at `/for-centres`.
export default async function ParentHome() {
  const t = await getT("landing.parents");
  const ts = await getT("screen");
  const tStats = await getT("landing.stats");

  const steps = ([1, 2, 3, 4] as const).map((n, i) => ({
    title: t(`step${n}Title`),
    text: t(`step${n}Text`),
    icon: STEP_ICONS[i],
  }));
  const trust = (["verified", "noTracking", "data"] as const).map((key) => ({
    title: t(`${key}Title`),
    text: t(`${key}Text`),
  }));

  return (
    <div className={`lp-root ${fontVars} overflow-x-clip`}>
      <SiteNav variant="parents" />

      {/* ---------- HERO (390 px first: hero + both actions above the fold) ---------- */}
      <section aria-labelledby="parent-hero-title" className="relative bg-[#f8f6f1]">
        <div aria-hidden="true" className="pointer-events-none absolute -left-40 top-10 h-[420px] w-[420px] rounded-full bg-teal-200/40 blur-[120px]" />
        <div className="relative mx-auto grid w-full max-w-6xl gap-10 px-4 pb-14 pt-20 sm:px-6 sm:pb-20 sm:pt-28 lg:grid-cols-[1.15fr_0.85fr] lg:items-center lg:pb-24 lg:pt-32">
          <div>
            <p className="mb-4 inline-flex items-center gap-2 rounded-full bg-white px-3.5 py-1.5 text-[0.82rem] font-medium text-teal-800 ring-1 ring-teal-200">
              <span className="h-1.5 w-1.5 rounded-full bg-teal-600" />
              {t("badge")}
            </p>
            <h1 id="parent-hero-title" className="lp-display text-[2.2rem] leading-[1.08] text-[#0b1f1d] sm:text-6xl lg:text-[4.4rem]">
              <span className="sr-only">DoctorNearMe. </span>
              {t("title")}
            </h1>
            <p className="mt-4 max-w-xl text-[0.95rem] leading-relaxed text-slate-700 sm:mt-6 sm:text-lg">{t("text")}</p>
            <div className="mt-6 flex flex-col gap-3 sm:mt-8 sm:flex-row">
              <ButtonLink href={PARENT_LINKS.checkIn} variant="teal" className="min-h-14 w-full text-base sm:w-auto">
                {t("checkIn")}
                <Arrow />
              </ButtonLink>
              <ButtonLink href={PARENT_LINKS.find} variant="ghost" className="min-h-14 w-full text-base sm:w-auto">
                {t("find")}
              </ButtonLink>
            </div>
            <p className="mt-3 text-sm">
              <Link
                href={PARENT_LINKS.voice}
                className="inline-flex min-h-11 items-center gap-2 font-semibold text-teal-800 underline underline-offset-4 hover:text-teal-900"
              >
                <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                  <path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3ZM19 11a7 7 0 0 1-14 0M12 18v3" />
                </svg>
                {ts("voiceSignIn")}
              </Link>
            </p>
          </div>

          <div className="relative hidden lg:block">
            <div className="relative aspect-[4/5] overflow-hidden rounded-[32px] shadow-2xl shadow-teal-900/15">
              <Image src={blocksImage} alt="" fill priority sizes="(min-width: 1024px) 480px, 0px" className="object-cover" placeholder="blur" />
            </div>
            <div className="absolute -bottom-6 -left-8 max-w-[300px] rounded-2xl bg-white p-5 shadow-xl shadow-black/10 ring-1 ring-[#0b1f1d]/[0.06]">
              <p className="lp-display text-4xl leading-none text-teal-700">{tStats("nddValue")}</p>
              <p className="mt-2 text-sm leading-relaxed text-slate-600">{tStats("nddLabel")}</p>
            </div>
          </div>
        </div>
      </section>

      {/* ---------- HOW IT WORKS: Check-in → Find → Visit → Practise at home ---------- */}
      <section id="how-it-works" aria-labelledby="how-title" className="scroll-mt-20 bg-white">
        <div className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 sm:py-24">
          <Reveal className="mb-10 max-w-2xl">
            <Eyebrow>{t("howEyebrow")}</Eyebrow>
            <h2 id="how-title" className="lp-display text-4xl leading-[1.05] text-[#0b1f1d] sm:text-5xl">
              {t("howTitle")}
            </h2>
          </Reveal>
          <ol className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {steps.map((step, i) => (
              <Reveal key={step.title} as="li" delay={i * 80} className="relative rounded-3xl bg-[#f8f6f1] p-6 ring-1 ring-[#0b1f1d]/[0.06]">
                <div className="mb-5 flex items-center justify-between">
                  <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-teal-700 text-white">
                    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d={step.icon} />
                    </svg>
                  </span>
                  <span className="font-mono text-sm text-slate-400" aria-hidden="true">
                    0{i + 1}
                  </span>
                </div>
                <h3 className="text-lg font-semibold text-[#0b1f1d]">{step.title}</h3>
                <p className="mt-1.5 text-[0.95rem] leading-relaxed text-slate-600">{step.text}</p>
              </Reveal>
            ))}
          </ol>
        </div>
      </section>

      {/* ---------- INDIAN STATISTICS (050 FR-3) ---------- */}
      <section id="numbers" aria-labelledby="numbers-title" className="scroll-mt-20">
        <div className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 sm:py-24">
          <Reveal className="mb-10 max-w-3xl">
            <Eyebrow>{tStats("eyebrow")}</Eyebrow>
            <h2 id="numbers-title" className="lp-display text-4xl leading-[1.05] text-[#0b1f1d] sm:text-5xl">
              {tStats("title")}
            </h2>
          </Reveal>
          <IndianStats />
        </div>
      </section>

      {/* ---------- TRUST ROW ---------- */}
      <section id="trust" aria-labelledby="trust-title" className="scroll-mt-20 bg-[#0b1f1d] text-white">
        <div className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
          <h2 id="trust-title" className="lp-display mb-8 text-4xl leading-[1.05] sm:text-5xl">
            {t("trustTitle")}
          </h2>
          <ul className="grid gap-px overflow-hidden rounded-3xl bg-white/10 sm:grid-cols-3">
            {trust.map((item) => (
              <li key={item.title} className="bg-[#0b1f1d] p-6 sm:p-7">
                <CheckIcon className="mb-4 h-6 w-6 text-teal-300" />
                <p className="mb-2 font-semibold">{item.title}</p>
                <p className="text-sm leading-relaxed text-white/70">{item.text}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* ---------- CLINIC CODE ---------- */}
      <section id="clinic-code" aria-labelledby="claim-title" className="scroll-mt-20 px-4 py-16 sm:px-6 sm:py-20">
        <Reveal className="mx-auto grid w-full max-w-6xl gap-6 rounded-3xl bg-teal-50 p-7 ring-1 ring-teal-200 sm:p-10 lg:grid-cols-[1.4fr_auto] lg:items-center">
          <div>
            <h2 id="claim-title" className="lp-display text-3xl leading-[1.1] text-[#0b1f1d] sm:text-4xl">
              {t("claimTitle")}
            </h2>
            <p className="mt-3 max-w-2xl text-base leading-relaxed text-slate-700 sm:text-lg">{t("claimText")}</p>
          </div>
          <ButtonLink href={PARENT_LINKS.claim} className="min-h-14 text-base">
            {t("claimCta")}
            <Arrow />
          </ButtonLink>
        </Reveal>
      </section>

      {/* ---------- FOR CENTRES (one line; the full pitch is on /for-centres) ---------- */}
      <section aria-label={t("centresCta")} className="border-t border-[#0b1f1d]/10 bg-white">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-2 px-4 py-8 text-base sm:flex-row sm:items-center sm:gap-3 sm:px-6">
          <p className="text-slate-600">{t("centresText")}</p>
          <Link href={PARENT_LINKS.forCentres} className="inline-flex min-h-11 items-center gap-1.5 font-semibold text-teal-800 hover:text-teal-900">
            {t("centresCta")}
            <Arrow className="h-3.5 w-3.5" />
          </Link>
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}
