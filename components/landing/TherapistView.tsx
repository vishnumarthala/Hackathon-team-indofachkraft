"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { SAMPLE_CALL, SAMPLE_CALL_SRC, type SampleTurn } from "@/components/landing/sampleCall";
import { DEMO_CALL_ENDED_EVENT, activeTurnIndex } from "@/components/landing/VoiceDemo";
import type { Brief } from "@/lib/types";

const FLAG_LABELS: Record<string, string> = { lost_speech: "Lost speech", self_injury: "Self-injury", other: "Red flag" };

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

// Index of the parent line that contains a red-flag quote (or the line sharing most of its words), -1 if none.
export function redFlagLineIndex(quote: string, turns: SampleTurn[]): number {
  const q = norm(quote);
  const exact = turns.findIndex((t) => t.role === "parent" && norm(t.text).includes(q));
  if (exact !== -1) return exact;
  const words = new Set(q.split(" ").filter((w) => w.length > 3));
  let best = -1;
  let bestScore = 0;
  turns.forEach((t, i) => {
    if (t.role !== "parent") return;
    const score = norm(t.text).split(" ").filter((w) => words.has(w)).length;
    if (score > bestScore) {
      best = i;
      bestScore = score;
    }
  });
  return bestScore >= Math.min(3, words.size) ? best : -1;
}

export function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

type Decision = "confirmed" | "editing" | null;

export function TherapistView({ brief }: { brief: Brief }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [active, setActive] = useState(-1);
  const [banner, setBanner] = useState(false);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [edits, setEdits] = useState<Record<string, string>>({});

  const flagLines = new Map<number, string>();
  for (const f of brief.red_flags) {
    const i = redFlagLineIndex(f.quote, SAMPLE_CALL);
    if (i !== -1) flagLines.set(i, f.type);
  }

  useEffect(() => {
    const onEnded = () => {
      setBanner(true);
      rootRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    };
    window.addEventListener(DEMO_CALL_ENDED_EVENT, onEnded);
    return () => window.removeEventListener(DEMO_CALL_ENDED_EVENT, onEnded);
  }, []);

  function playFrom(index: number) {
    const audio = audioRef.current;
    if (!audio || index < 0) return;
    audio.currentTime = SAMPLE_CALL[index].start;
    void audio.play().catch(() => {});
    setActive(index);
  }

  const confirmedCount = Object.values(decisions).filter((d) => d === "confirmed").length;

  return (
    <div ref={rootRef} className="scroll-mt-6">
      {banner && (
        <div role="status" className="mb-4 flex items-start gap-3 rounded-2xl bg-teal-700 px-4 py-3 text-sm text-white shadow-lg">
          <span className="mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full bg-teal-200" />
          Your demo call has ended. This is how an intake call reaches the therapist (example case, synthetic data).
        </div>
      )}

      <div className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-2xl shadow-slate-900/10">
        {/* App-like header */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-slate-50 px-5 py-3">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-teal-700 text-sm font-bold text-white">R</span>
            <div>
              <p className="font-semibold text-slate-900">Ravi (synthetic)</p>
              <p className="text-xs text-slate-500">40 months · Telugu · Therapist: Demo Therapist</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="rounded-full bg-emerald-100 px-2.5 py-1 font-semibold text-emerald-800">
              ✓ Intake call completed · {clock(SAMPLE_CALL[SAMPLE_CALL.length - 1].end)}
            </span>
            <span className="rounded-full bg-white px-2.5 py-1 font-medium text-slate-600 ring-1 ring-slate-200">
              AI documents, the clinician decides
            </span>
          </div>
        </div>

        <div className="grid lg:grid-cols-[1fr_1.15fr]">
          {/* Recording and transcript */}
          <div className="border-b border-slate-200 p-5 lg:border-b-0 lg:border-r">
            <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-slate-500">Call recording</p>
            <audio
              ref={audioRef}
              controls
              preload="metadata"
              src={SAMPLE_CALL_SRC}
              onTimeUpdate={(e) => setActive(activeTurnIndex(SAMPLE_CALL, e.currentTarget.currentTime))}
              className="mb-4 w-full"
            >
              <track kind="captions" />
            </audio>
            <ol aria-label="Intake call transcript" className="max-h-[26rem] space-y-1.5 overflow-y-auto pr-1 lg:max-h-none">
              {SAMPLE_CALL.map((t, i) => {
                const flag = flagLines.get(i);
                return (
                  <li key={i}>
                    <button
                      type="button"
                      onClick={() => playFrom(i)}
                      className={`flex w-full gap-3 rounded-xl px-3 py-2 text-left text-sm transition-colors ${
                        i === active ? "bg-teal-50 ring-2 ring-teal-500" : flag ? "bg-rose-50 hover:bg-rose-100" : "hover:bg-slate-50"
                      }`}
                    >
                      <span className="w-9 shrink-0 pt-0.5 font-mono text-xs tabular-nums text-slate-400">{clock(t.start)}</span>
                      <span className="min-w-0">
                        <span className={`mr-1.5 text-xs font-semibold uppercase ${t.role === "agent" ? "text-teal-700" : "text-slate-600"}`}>
                          {t.role === "agent" ? "AI" : "Parent"}
                        </span>
                        {flag && (
                          <span className="mr-1.5 rounded-full bg-rose-100 px-2 py-0.5 text-[11px] font-semibold text-rose-700">
                            Red flag
                          </span>
                        )}
                        <span className="text-slate-700">{t.text}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </div>

          {/* Pre-session brief */}
          <div className="space-y-5 p-5">
            <div>
              <div className="mb-2 flex items-center justify-between gap-2">
                <p className="text-xs font-semibold uppercase tracking-widest text-slate-500">Pre-session brief</p>
                <span className="rounded-full bg-amber-50 px-2.5 py-0.5 text-[11px] font-semibold text-amber-800 ring-1 ring-amber-200">
                  Parent-reported
                </span>
              </div>
              <p className="text-sm leading-relaxed text-slate-700">{brief.summary}</p>
            </div>

            <div>
              <p className="mb-2 text-sm font-semibold text-slate-900">Red flags</p>
              <ul className="space-y-2">
                {brief.red_flags.map((f) => {
                  const line = redFlagLineIndex(f.quote, SAMPLE_CALL);
                  return (
                    <li key={`${f.type}-${f.turn_id}`} className="flex items-start justify-between gap-3 rounded-xl bg-rose-50 p-3 text-sm">
                      <span>
                        <span className="mr-2 rounded-full bg-rose-100 px-2 py-0.5 text-xs font-semibold text-rose-700">
                          {FLAG_LABELS[f.type] ?? f.type}
                        </span>
                        <span className="italic text-slate-700">&ldquo;{f.quote}&rdquo;</span>
                      </span>
                      {line !== -1 && (
                        <button
                          type="button"
                          onClick={() => playFrom(line)}
                          className="shrink-0 rounded-full bg-white px-3 py-1 text-xs font-semibold text-rose-700 ring-1 ring-rose-200 hover:bg-rose-100"
                          aria-label={`Play the moment: ${FLAG_LABELS[f.type] ?? f.type}`}
                        >
                          ▶ {clock(SAMPLE_CALL[line].start)}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>

            <div>
              <div className="mb-2 flex items-center justify-between gap-2">
                <p className="text-sm font-semibold text-slate-900">Parent&apos;s answers</p>
                <span className="text-xs tabular-nums text-slate-500">
                  {confirmedCount} of {brief.parent_reported.length} confirmed
                </span>
              </div>
              <ul className="divide-y divide-slate-100 rounded-xl ring-1 ring-slate-200">
                {brief.parent_reported.map((r) => {
                  const decision = decisions[r.field_id] ?? null;
                  const value = edits[r.field_id] ?? r.value;
                  return (
                    <li key={r.field_id} className="flex flex-wrap items-start justify-between gap-2 px-3 py-2.5 text-sm">
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-semibold text-slate-500">{r.label}</p>
                        {decision === "editing" ? (
                          <input
                            aria-label={`Edit ${r.label}`}
                            value={value}
                            onChange={(e) => setEdits((p) => ({ ...p, [r.field_id]: e.target.value }))}
                            className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1 text-sm"
                          />
                        ) : (
                          <p className="text-slate-800">{value}</p>
                        )}
                      </div>
                      {decision === "confirmed" ? (
                        <span className="shrink-0 rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-800">
                          ✓ Confirmed by therapist
                        </span>
                      ) : (
                        <span className="flex shrink-0 gap-1.5">
                          <button
                            type="button"
                            onClick={() => setDecisions((p) => ({ ...p, [r.field_id]: "confirmed" }))}
                            className="rounded-full bg-teal-700 px-3 py-1 text-xs font-semibold text-white hover:bg-teal-800"
                          >
                            Confirm
                          </button>
                          {decision !== "editing" && (
                            <button
                              type="button"
                              onClick={() => setDecisions((p) => ({ ...p, [r.field_id]: "editing" }))}
                              className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50"
                            >
                              Edit
                            </button>
                          )}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>

            <div>
              <p className="mb-2 text-sm font-semibold text-slate-900">Questions to verify in session 1</p>
              <ul className="list-disc space-y-1.5 pl-5 text-sm text-slate-700">
                {brief.questions_to_verify.map((q) => (
                  <li key={q}>{q}</li>
                ))}
              </ul>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 bg-slate-50 px-5 py-3 text-xs text-slate-500">
          <span>Parent-reported · the therapist confirms in session 1. This is not a diagnosis.</span>
          <Link href="/dashboard" className="font-semibold text-teal-800 underline-offset-2 hover:underline">
            Open the full demo →
          </Link>
        </div>
      </div>
    </div>
  );
}
