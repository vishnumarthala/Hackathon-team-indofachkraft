// Ticket 026 FR-4: last-4-weeks adherence sparkline (inline SVG bars, no chart library). No hooks, so it renders in
// server and client trees alike. Each bar = done / expected for one Monday-start week (capped at 100%); the dashed
// line is the expected count. The accessible name lists every week in words.
import type { Adherence } from "@/lib/home-program/adherence";

const W = 96;
const H = 28;
const GAP = 4;

export function Sparkline({ weeks, label }: { weeks: Adherence[]; label: string }) {
  const bar = (W - GAP * (weeks.length - 1)) / Math.max(1, weeks.length);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={label} className="overflow-visible" data-sparkline>
      <line x1={0} x2={W} y1={2} y2={2} stroke="#94a3b8" strokeDasharray="2 2" />
      {weeks.map((w, i) => {
        const h = Math.max(1, (Math.min(w.done, w.expected) / w.expected) * (H - 2));
        return (
          <rect
            key={w.week_start}
            x={i * (bar + GAP)}
            y={H - h}
            width={bar}
            height={h}
            rx={1.5}
            fill={w.met ? "#047857" : w.done > 0 ? "#0f766e" : "#cbd5e1"}
            data-week={w.week_start}
            data-done={w.done}
          />
        );
      })}
    </svg>
  );
}
