import type { ReactNode } from "react";
import { Reveal } from "./Reveal";


function Tile({
  title,
  text,
  children,
  className = "",
  delay = 0,
}: {
  title: string;
  text: string;
  children: ReactNode;
  className?: string;
  delay?: number;
}) {
  return (
    <Reveal delay={delay} className={`lp-card flex flex-col overflow-hidden rounded-3xl border border-[#0b1f1d]/[0.07] bg-white ${className}`}>
      <div className="p-6 pb-0 sm:p-7 sm:pb-0">
        <h3 className="text-lg font-semibold text-[#0b1f1d]">{title}</h3>
        <p className="mt-1.5 max-w-md text-[0.95rem] leading-relaxed text-slate-600">{text}</p>
      </div>
      <div className="mt-6 flex flex-1 items-end px-6 pb-6 sm:px-7 sm:pb-7" aria-hidden="true">
        {children}
      </div>
    </Reveal>
  );
}

const ROWS = [
  { n: 1, t: "Has poor eye contact", q: "he does not look at us when we talk", ts: "00:42", r: 4, done: true },
  { n: 15, t: "Acquired speech and lost it", q: "said a few words at two, then stopped", ts: "01:18", r: 5, done: true },
  { n: 24, t: "Engages in stereotyped and repetitive motor mannerisms", q: "he flaps his hands when he is excited", ts: "02:31", r: 3, done: false },
];

export function Features() {
  return (
    <div className="grid gap-5 lg:grid-cols-6">
      <Tile
        className="lg:col-span-4"
        title="Every rating comes with its evidence"
        text="Each suggested ISAA rating links to the parent's own words and the second it was said. Click to hear it."
      >
        <div className="w-full space-y-2.5">
          {ROWS.map((r) => (
            <div key={r.n} className="flex flex-col gap-2 rounded-2xl border border-slate-100 bg-[#f8f6f1] p-3.5 sm:flex-row sm:items-center sm:gap-4">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-slate-800">
                  {r.n}. {r.t}
                </p>
                <p className="mt-0.5 truncate text-[0.82rem] italic text-slate-500">
                  &ldquo;{r.q}&rdquo; <span className="font-mono not-italic text-slate-400">· {r.ts}</span>
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className="rounded-lg bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 ring-1 ring-slate-200">Rating {r.r}</span>
                {r.done ? (
                  <span className="rounded-lg bg-teal-50 px-2.5 py-1 text-xs font-semibold text-teal-800 ring-1 ring-teal-200">Confirmed</span>
                ) : (
                  <span className="rounded-lg bg-[#0b1f1d] px-2.5 py-1 text-xs font-semibold text-white">Confirm</span>
                )}
              </div>
            </div>
          ))}
        </div>
      </Tile>

      <Tile className="lg:col-span-2" delay={80} title="You stay in charge" text="Confirm, edit or reject each item. The score only counts what you confirmed.">
        <div className="w-full rounded-2xl bg-[#0b1f1d] p-5 text-white">
          <p className="text-xs font-medium uppercase tracking-wider text-teal-300">ISAA total</p>
          <p className="lp-display mt-1 text-5xl">92</p>
          <p className="mt-1 text-xs text-white/60">from 38 confirmed items</p>
          <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-white/10">
            <div className="h-full w-[95%] rounded-full bg-teal-400" />
          </div>
        </div>
      </Tile>

      <Tile className="lg:col-span-2" delay={0} title="Pre-session brief" text="What the parent shared, the main concerns, and what to watch for.">
        <div className="w-full space-y-2">
          {["Main concern: few words", "First noticed: 18 months", "Watch for: response to name"].map((x, i) => (
            <div key={x} className="flex items-center gap-2.5 rounded-xl bg-[#f8f6f1] px-3 py-2.5 text-[0.82rem] text-slate-700">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-teal-100 text-[0.65rem] font-bold text-teal-800">{i + 1}</span>
              {x}
            </div>
          ))}
        </div>
      </Tile>

      <Tile className="lg:col-span-2" delay={80} title="Ask the case" text="Ask a question in plain words. The answer cites the intake or the session.">
        <div className="w-full space-y-2.5 text-[0.82rem]">
          <p className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-md bg-[#0b1f1d] px-3.5 py-2 text-white">When did speech stop?</p>
          <div className="max-w-[92%] rounded-2xl rounded-bl-md bg-[#f8f6f1] px-3.5 py-2.5 text-slate-700">
            <span className="lp-caret">Around age two, after a few first words.</span>
            <span className="mt-1.5 block w-fit rounded-md bg-white px-2 py-0.5 text-[0.7rem] font-medium text-teal-800 ring-1 ring-teal-100">Session 1 · 01:18</span>
          </div>
        </div>
      </Tile>

      <Tile className="lg:col-span-2" delay={160} title="Parent voice notes" text="Parents can add a voice note in their language. It travels with the case.">
        <div className="flex w-full items-center gap-3 rounded-2xl bg-[#f8f6f1] p-3.5">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#ef6f5e] text-white">
            <svg viewBox="0 0 20 20" className="ml-0.5 h-4 w-4" fill="currentColor">
              <path d="M6 4.5v11a1 1 0 0 0 1.5.86l9-5.5a1 1 0 0 0 0-1.72l-9-5.5A1 1 0 0 0 6 4.5Z" />
            </svg>
          </span>
          <div className="flex flex-1 items-center gap-[3px] overflow-hidden">
            {[6, 12, 18, 9, 14, 20, 11, 7, 16, 10, 18, 8, 13, 6, 15, 9, 12, 7].map((h, i) => (
              <span key={i} className="w-[3px] shrink-0 rounded-full bg-[#ef6f5e]/70" style={{ height: h }} />
            ))}
          </div>
          <span className="font-mono text-xs text-slate-500">0:24</span>
        </div>
      </Tile>
    </div>
  );
}

export function LanguageRow() {
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="mr-1 text-slate-500">Parents talk in</span>
      {[
        { l: "English", soon: false },
        { l: "हिन्दी", soon: false },
        { l: "తెలుగు", soon: false },
        { l: "Deutsch", soon: true },
      ].map(({ l, soon }) => (
        <span
          key={l}
          className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 font-medium ${
            soon ? "border border-dashed border-[#0b1f1d]/20 text-slate-500" : "bg-white text-[#0b1f1d] ring-1 ring-[#0b1f1d]/10"
          }`}
        >
          {!soon && <span className="h-1.5 w-1.5 rounded-full bg-teal-600" />}
          {l}
          {soon && <span className="text-xs">soon</span>}
        </span>
      ))}
    </div>
  );
}
