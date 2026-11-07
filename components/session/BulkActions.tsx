"use client";

import { useState } from "react";

type Pending = "confirm_suggested" | "rate_unrated";

export function BulkActions({
  suggestedCount,
  unratedCount,
  busy,
  error,
  onRun,
}: {
  suggestedCount: number;
  unratedCount: number;
  busy: boolean;
  error: string | null;
  onRun: (action: Pending) => Promise<void>;
}) {
  const [pending, setPending] = useState<Pending | null>(null);

  const question =
    pending === "confirm_suggested"
      ? `Confirm ${suggestedCount} AI suggestions you have reviewed?`
      : `Set ${unratedCount} unrated items to 1 (Rarely)?`;

  async function onYes() {
    if (!pending) return;
    const action = pending;
    setPending(null);
    await onRun(action);
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy || suggestedCount === 0}
          onClick={() => setPending("confirm_suggested")}
          className="rounded bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          Confirm all remaining suggestions
        </button>
        <button
          type="button"
          disabled={busy || unratedCount === 0}
          onClick={() => setPending("rate_unrated")}
          className="rounded border border-slate-400 px-3 py-2 text-sm font-medium text-slate-900 disabled:opacity-50"
        >
          Rate all unrated as 1 (Rarely)
        </button>
      </div>

      {pending && (
        <div
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="bulk-question"
          className="rounded border border-slate-300 bg-slate-50 p-3"
        >
          <p id="bulk-question" className="text-sm font-medium text-slate-900">
            {question}
          </p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              autoFocus
              onClick={onYes}
              className="rounded bg-slate-900 px-3 py-1 text-sm font-medium text-white"
            >
              Yes
            </button>
            <button
              type="button"
              onClick={() => setPending(null)}
              className="rounded border border-slate-400 px-3 py-1 text-sm font-medium text-slate-900"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
