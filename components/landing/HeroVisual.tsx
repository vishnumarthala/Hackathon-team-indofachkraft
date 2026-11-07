"use client";

import { useEffect, useState } from "react";
import "./landing.css";

// Synthetic demo rows only. Mirrors the real review screen: suggested rating + evidence + timestamp,
// then the therapist confirms.
const ROWS = [
  { item: 1, text: "Has poor eye contact", rating: 4, quote: "he does not look at us when we talk", ts: "00:42" },
  { item: 15, text: "Acquired speech and lost it", rating: 5, quote: "said a few words at two, then stopped", ts: "01:18", flag: true },
  { item: 31, text: "Unusually sensitive to sensory stimuli", rating: 4, quote: "covers his ears at the mixer", ts: "02:05" },
];

// Step n: rows < n/2 visible; odd steps confirm the latest row.
const STEPS = ROWS.length * 2;

export function HeroVisual() {
  const [step, setStep] = useState(STEPS);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    // Starts fully confirmed (also the server render), holds briefly, then loops the fill-in.
    const id = window.setInterval(() => setStep((s) => (s >= STEPS + 3 ? 0 : s + 1)), 1100);
    return () => window.clearInterval(id);
  }, []);

  const shown = Math.min(ROWS.length, Math.ceil(step / 2));
  const confirmed = Math.min(ROWS.length, Math.floor(step / 2));
  const score = ROWS.slice(0, confirmed).reduce((a, r) => a + r.rating, 0);

  return (
    <div className="relative mx-auto w-full max-w-md" aria-hidden="true">
      {/* Floating parent-call chip */}
      <div className="absolute -top-5 left-2 z-10 flex items-center gap-2 rounded-full border border-white/70 bg-white/90 px-3 py-1.5 text-xs font-medium text-slate-700 shadow-lg shadow-teal-900/10 backdrop-blur sm:-left-6">
        <span className={`lp-wave flex h-5 items-center gap-[3px]`} style={{ color: "#f97362" }}>
          <span style={{ animationDelay: "0ms" }} />
          <span style={{ animationDelay: "150ms" }} />
          <span style={{ animationDelay: "300ms" }} />
          <span style={{ animationDelay: "450ms" }} />
        </span>
        Intake call · Telugu
      </div>

      <div className="rounded-3xl border border-white/60 bg-white/80 p-5 shadow-2xl shadow-teal-900/15 backdrop-blur-xl">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-teal-700">Session 1 · ISAA</p>
            <p className="text-sm text-slate-500">Ravi, 3 yrs (synthetic)</p>
          </div>
          <span className="flex items-center gap-1.5 rounded-full bg-rose-50 px-2.5 py-1 text-xs font-semibold text-rose-700">
            <span className={`lp-pulse h-2 w-2 rounded-full bg-rose-500`} />
            Documenting
          </span>
        </div>

        <ul className="space-y-3">
          {ROWS.map((r, i) => {
            const visible = i < shown;
            const isConfirmed = i < confirmed;
            return (
              <li
                key={r.item}
                className={`rounded-2xl border p-3 transition-colors duration-300 ${
                  visible ? "lp-row-in" : "opacity-0"
                } ${isConfirmed ? "border-teal-200 bg-teal-50/70" : "border-slate-200 bg-white"}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <p className="text-sm font-semibold text-slate-800">
                    <span className="mr-1.5 text-slate-400">#{r.item}</span>
                    {r.text}
                  </p>
                  <span
                    className={`shrink-0 rounded-lg px-2 py-0.5 text-xs font-bold ${
                      isConfirmed ? "bg-teal-600 text-white" : "bg-amber-100 text-amber-800"
                    }`}
                  >
                    {r.rating}/5
                  </span>
                </div>
                <p className="mt-1.5 text-xs italic text-slate-600">
                  “{r.quote}” <span className="not-italic font-medium text-teal-700">▸ {r.ts}</span>
                </p>
                <div className="mt-2 flex items-center gap-2 text-xs">
                  {r.flag && (
                    <span className="rounded-full bg-rose-100 px-2 py-0.5 font-semibold text-rose-700">Red flag</span>
                  )}
                  <span className={isConfirmed ? "font-semibold text-teal-700" : "text-slate-500"}>
                    {isConfirmed ? "✓ Confirmed by therapist" : "AI suggestion · awaiting review"}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>

        <div className="mt-4 flex items-center justify-between rounded-2xl bg-slate-900 px-4 py-3 text-white">
          <span className="text-xs text-slate-300">Confirmed items</span>
          <span className="text-sm font-semibold tabular-nums">
            {confirmed}/40 · score {score}
          </span>
        </div>
      </div>

      {/* Floating specialist chip */}
      <div className="absolute -bottom-5 right-2 flex items-center gap-2 rounded-full border border-white/70 bg-white/90 px-3 py-1.5 text-xs font-medium text-slate-700 shadow-lg shadow-teal-900/10 backdrop-blur sm:-right-6">
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-teal-600 text-[10px] font-bold text-white">→</span>
        Referral packet ready
      </div>
    </div>
  );
}
