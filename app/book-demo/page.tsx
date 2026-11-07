import type { Metadata } from "next";
import Link from "next/link";
import "@/components/landing/landing.css";
import { DemoRequestForm } from "@/components/landing/DemoRequestForm";
import { fontVars } from "@/components/landing/fonts";
import { Logo } from "@/components/landing/ui";

export const metadata: Metadata = {
  title: "Book a demo - CareThread",
  description: "See CareThread on a sample case and join the pilot for early intervention centres.",
};

const STEPS = [
  { t: "Tell us who you are", x: "Two short steps, about a minute." },
  { t: "Pick a time", x: "We email you within one working day." },
  { t: "See it on a sample case", x: "Intake call, session, ISAA review and referral, in one short video call." },
];

export default function BookDemoPage() {
  return (
    <div className={`lp-root ${fontVars} min-h-screen`}>
      <div className="grid min-h-screen lg:grid-cols-[1fr_1.05fr]">
        {/* Left: why and what happens next */}
        <aside className="relative overflow-hidden bg-[#0b1f1d] px-6 pb-14 pt-8 text-white sm:px-12 lg:px-16 lg:pb-16">
          <div aria-hidden="true" className="pointer-events-none absolute -right-32 -top-32 h-96 w-96 rounded-full bg-teal-500/25 blur-[110px]" />
          <div aria-hidden="true" className="pointer-events-none absolute -bottom-40 -left-24 h-96 w-96 rounded-full bg-[#ef6f5e]/20 blur-[110px]" />
          <div className="relative flex h-full flex-col">
            <Link href="/" aria-label="CareThread home" className="w-fit rounded-lg focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-white/30">
              <Logo light />
            </Link>

            <div className="lp-fade-up mt-10 max-w-lg lg:mt-24">
              <p className="mb-4 text-xs font-semibold uppercase tracking-[0.18em] text-teal-300">Book a demo</p>
              <h1 className="lp-display text-[2.6rem] leading-[1.04] sm:text-6xl">
                See your next assessment <em className="text-teal-300">document itself.</em>
              </h1>
              <p className="mt-5 leading-relaxed text-white/70 sm:text-lg">
                We are onboarding pilot centres and therapists in Germany and India. Book a short demo and we&apos;ll
                show you CareThread on a sample case.
              </p>

              <ol className="mt-10 hidden space-y-6 lg:block">
                {STEPS.map((s, i) => (
                  <li key={s.t} className="flex gap-4">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-white/20 text-sm font-semibold text-teal-200">
                      {i + 1}
                    </span>
                    <div>
                      <p className="font-semibold">{s.t}</p>
                      <p className="text-sm text-white/60">{s.x}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </div>

            <figure className="mt-14 hidden max-w-lg border-t border-white/10 pt-8 lg:mt-auto lg:block">
              <blockquote className="lp-display text-2xl leading-snug text-white/90">
                &ldquo;AI documents, the clinician decides.&rdquo;
              </blockquote>
              <figcaption className="mt-2 text-sm text-white/50">The principle CareThread is built on</figcaption>
            </figure>
          </div>
        </aside>

        {/* Right: the form */}
        <div className="flex items-start justify-center px-5 py-12 sm:px-10 lg:items-center lg:py-16">
          <div className="w-full max-w-lg">
            <Link href="/" className="mb-8 inline-flex items-center gap-1.5 text-sm font-medium text-slate-600 hover:text-[#0b1f1d]">
              <svg viewBox="0 0 20 20" className="h-4 w-4" fill="currentColor" aria-hidden="true">
                <path fillRule="evenodd" d="M17 10a.75.75 0 0 1-.75.75H5.65l3.9 3.7a.75.75 0 1 1-1.04 1.08l-5.25-5a.75.75 0 0 1 0-1.08l5.25-5a.75.75 0 1 1 1.04 1.08l-3.9 3.7h10.6A.75.75 0 0 1 17 10Z" clipRule="evenodd" />
              </svg>
              Back to home
            </Link>
            <DemoRequestForm />
            <p className="mt-10 text-center text-sm text-slate-600">
              Already using CareThread?{" "}
              <Link href="/login" className="font-semibold text-teal-800 underline-offset-4 hover:underline">
                Log in
              </Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
