import Link from "next/link";
import { Logo } from "./ui";

const COLS = [
  {
    title: "Product",
    links: [
      { href: "/#voice-demo", label: "AI intake call" },
      { href: "/#how", label: "How it works" },
      { href: "/#features", label: "Features" },
      { href: "/#trust", label: "Trust and privacy" },
      { href: "/#faq", label: "FAQ" },
    ],
  },
  {
    title: "Get started",
    links: [
      { href: "/book-demo", label: "Book a demo" },
      { href: "/login", label: "Log in" },
    ],
  },
];

export function SiteFooter() {
  return (
    <footer className="border-t border-[#0b1f1d]/10 bg-[#f8f6f1]">
      <div className="mx-auto grid w-full max-w-6xl gap-10 px-4 py-14 sm:px-6 md:grid-cols-[1.4fr_1fr_1fr]">
        <div>
          <Logo />
          <p className="mt-4 max-w-xs text-sm leading-relaxed text-slate-600">
            The AI assistant for early intervention therapists. AI documents, the clinician decides.
          </p>
        </div>
        {COLS.map((c) => (
          <div key={c.title}>
            <p className="mb-4 text-sm font-semibold text-[#0b1f1d]">{c.title}</p>
            <ul className="space-y-2.5">
              {c.links.map((l) => (
                <li key={l.href}>
                  <Link href={l.href} className="text-sm text-slate-600 transition-colors hover:text-teal-800">
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="border-t border-[#0b1f1d]/10">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-2 px-4 py-6 text-xs text-slate-500 sm:flex-row sm:justify-between sm:px-6">
          <p>© 2026 DoctorNearMe. Built for early intervention teams in India.</p>
          <p>Built on ElevenLabs and Google Gemini. DoctorNearMe supports clinicians; it is not a diagnosis.</p>
        </div>
      </div>
    </footer>
  );
}
