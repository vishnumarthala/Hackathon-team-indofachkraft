"use client";

import { ISAA } from "@/lib/isaa";
import type { FactRow } from "@/lib/types";
import { ItemRow } from "./ItemRow";

export function IsaaForm({
  facts,
  busyFactId,
  errors,
  onRate,
  onConfirm,
  onSeek,
}: {
  facts: FactRow[];
  busyFactId: string | null;
  errors: Record<string, string>;
  onRate: (fact: FactRow, value: number) => void;
  onConfirm: (fact: FactRow) => void;
  onSeek: (segmentId: string, startSec: number) => void;
}) {
  const byItem = new Map(facts.map((f) => [Number(f.item_id), f]));

  return (
    <div className="space-y-6">
      {ISAA.domains.map((domain) => (
        <section key={domain.id} aria-labelledby={`domain-${domain.id}`}>
          <h3 id={`domain-${domain.id}`} className="border-b border-slate-300 pb-1 text-base font-semibold text-slate-900">
            {domain.name}
          </h3>
          <ol>
            {domain.items.map((itemId) => {
              const item = ISAA.items.find((i) => i.id === itemId);
              if (!item) return null;
              const fact = byItem.get(itemId);
              return (
                <ItemRow
                  key={itemId}
                  item={item}
                  fact={fact}
                  busy={!!fact && fact.id === busyFactId}
                  error={fact ? (errors[fact.id] ?? null) : null}
                  onRate={onRate}
                  onConfirm={onConfirm}
                  onSeek={onSeek}
                />
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}
