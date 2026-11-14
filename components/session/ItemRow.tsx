"use client";

import { ratingLabel, type IsaaItem } from "@/lib/isaa";
import type { FactRow } from "@/lib/types";
import { formatClock } from "./time";

const RATINGS = [1, 2, 3, 4, 5] as const;

export function ratingValue(value: FactRow["value"] | undefined): number | null {
  return typeof value === "number" ? value : null;
}

export function badgeFor(fact: FactRow): { label: string; className: string } {
  if (fact.source === "therapist_voice" && fact.status !== "edited") {
    return { label: "Voice note", className: "bg-violet-100 text-violet-900" };
  }
  if (fact.status === "confirmed") return { label: "Confirmed", className: "bg-emerald-100 text-emerald-900" };
  if (fact.status === "edited") return { label: "Edited", className: "bg-sky-100 text-sky-900" };
  return { label: "AI suggested", className: "bg-amber-100 text-amber-900" };
}

export function ItemRow({
  item,
  fact,
  busy,
  error,
  onRate,
  onConfirm,
  onSeek,
}: {
  item: IsaaItem;
  fact: FactRow | undefined;
  busy: boolean;
  error: string | null;
  onRate: (fact: FactRow, value: number) => void;
  onConfirm: (fact: FactRow) => void;
  onSeek: (segmentId: string, startSec: number) => void;
}) {
  const value = ratingValue(fact?.value);
  const badge = fact ? badgeFor(fact) : null;
  const evidence = fact?.evidence ?? null;
  const canConfirm = !!fact && value !== null && fact.status === "suggested" && !busy;

  return (
    <li data-item={item.id} className="space-y-2 border-b border-slate-100 py-3 last:border-b-0">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="min-w-0 font-medium text-slate-900">
          {item.id}. {item.text}
        </p>
        <div className="flex items-center gap-2 text-xs">
          {badge && <span className={`rounded-full px-2 py-0.5 font-medium ${badge.className}`}>{badge.label}</span>}
          {fact && badge?.label === "AI suggested" && fact.confidence !== null && (
            <span className="text-slate-600">{Math.round(fact.confidence * 100)}%</span>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1" role="group" aria-label={`Rating for item ${item.id}`}>
          {RATINGS.map((r) => (
            <button
              key={r}
              type="button"
              aria-label={`Rate item ${item.id} as ${r}`}
              aria-pressed={value === r}
              title={ratingLabel(r)}
              disabled={!fact || busy}
              onClick={() => fact && onRate(fact, r)}
              className={`h-8 w-8 rounded border text-sm font-medium disabled:opacity-50 ${
                value === r
                  ? "border-teal-700 bg-teal-700 text-white"
                  : "border-slate-300 bg-white text-slate-800 hover:bg-slate-100"
              }`}
            >
              {r}
            </button>
          ))}
        </div>
        <button
          type="button"
          aria-label={`Confirm item ${item.id}`}
          disabled={!canConfirm}
          onClick={() => fact && onConfirm(fact)}
          className="rounded border border-emerald-700 px-3 py-1 text-sm font-medium text-emerald-800 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:border-slate-300 disabled:text-slate-400"
        >
          Confirm
        </button>
      </div>

      {evidence && (
        <div className="flex flex-wrap items-start gap-2 text-sm">
          <button
            type="button"
            onClick={() => onSeek(evidence.segment_id, evidence.start_sec)}
            className="shrink-0 rounded bg-slate-100 px-2 py-0.5 font-mono text-xs text-slate-800 hover:bg-slate-200"
          >
            ▶ {formatClock(evidence.start_sec)}
          </button>
          <span className="min-w-0 break-words text-slate-700 italic">&quot;{evidence.quote}&quot;</span>
          {!evidence.verified && <span className="text-xs font-medium text-orange-700">Unverified quote</span>}
        </div>
      )}
      {value === null && <p className="text-sm font-medium text-orange-700">No evidence - needs rating</p>}
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
    </li>
  );
}
