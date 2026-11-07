import type { Brief } from "@/lib/types";

const FLAG_LABELS: Record<string, string> = {
  lost_speech: "Lost speech",
  self_injury: "Self-injury",
  other: "Red flag",
};

// Server-safe preview of what the therapist receives after the intake call (from the demo brief fixture).
export function IntakeBriefPreview({ brief }: { brief: Brief }) {
  return (
    <div className="rounded-3xl border border-teal-200 bg-gradient-to-br from-teal-50 to-white p-5 sm:p-6">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold uppercase tracking-widest text-teal-700">What the therapist gets</p>
        <span className="rounded-full bg-white px-3 py-1 text-xs font-medium text-slate-600 ring-1 ring-slate-200">
          Pre-session brief · parent-reported
        </span>
      </div>
      <p className="mb-4 text-sm leading-relaxed text-slate-700">{brief.summary}</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <p className="mb-2 text-sm font-semibold text-slate-900">Red flags, with the parent&apos;s words</p>
          <ul className="space-y-2">
            {brief.red_flags.map((f) => (
              <li key={`${f.type}-${f.turn_id}`} className="rounded-xl bg-white p-3 text-sm ring-1 ring-rose-100">
                <span className="mr-2 rounded-full bg-rose-100 px-2 py-0.5 text-xs font-semibold text-rose-700">
                  {FLAG_LABELS[f.type] ?? f.type}
                </span>
                <span className="italic text-slate-700">&ldquo;{f.quote}&rdquo;</span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <p className="mb-2 text-sm font-semibold text-slate-900">Questions to verify in session 1</p>
          <ul className="list-disc space-y-1.5 pl-5 text-sm text-slate-700">
            {brief.questions_to_verify.slice(0, 3).map((q) => (
              <li key={q}>{q}</li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
