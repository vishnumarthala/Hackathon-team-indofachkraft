import type { Metadata } from "next";
import Link from "next/link";
import { PhaseCards } from "@/components/landing/PhaseCards";
import { PilotForm } from "@/components/landing/PilotForm";

const SUBTITLE =
  "CareThread is the AI assistant for early intervention therapists. It talks to the parent before the first session, documents the online session and fills the assessment form, and hands the complete case to the specialist.";

export const metadata: Metadata = {
  title: "CareThread - AI assistant for early intervention therapists",
  description: "CareThread is the AI assistant for early intervention therapists.",
};

export default function Home() {
  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-10 sm:py-16">
      <section className="mb-10">
        <h1 className="mb-4 text-4xl font-bold tracking-tight text-slate-900 sm:text-5xl">
          CareThread
        </h1>
        <p className="mb-6 max-w-3xl text-lg text-slate-700">{SUBTITLE}</p>
        <div className="flex flex-wrap items-center gap-4">
          <a
            href="#pilot"
            className="rounded-md bg-teal-700 px-5 py-3 font-semibold text-white hover:bg-teal-800"
          >
            Join the pilot
          </a>
          <Link href="/dashboard" className="font-semibold text-teal-800 underline underline-offset-4">
            Open the demo
          </Link>
        </div>
      </section>

      <section className="mb-10">
        <PhaseCards />
      </section>

      <section className="mb-12 space-y-2">
        <p className="text-xl font-semibold text-slate-900">AI documents, the clinician decides.</p>
        <p className="text-slate-700">
          Pilot pricing: Rs 3,000 (India) / EUR 199 (Germany) per clinician per month
        </p>
      </section>

      <section id="pilot" className="relative max-w-xl scroll-mt-8">
        <h2 className="mb-2 text-2xl font-bold text-slate-900">Join the pilot</h2>
        <p className="mb-6 text-slate-700">
          For early intervention therapists, child psychologists, centres and parents.
        </p>
        <PilotForm />
      </section>
    </main>
  );
}
