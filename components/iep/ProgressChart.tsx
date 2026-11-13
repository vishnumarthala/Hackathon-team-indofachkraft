// Ticket 025 FR-5/FR-6, NFR-2: a small SVG line chart of one goal's progress with baseline and target lines
// (no chart library) and a `Show data` table alternative. No hooks: renders in server and client trees alike;
// callers pass translated labels and pre-formatted values.
import { VALUE_RANGES, type MeasureType } from "@/lib/iep/schema";

export type ChartPoint = { observed_on: string; value: number; dateLabel: string; valueLabel: string; note?: string | null };

export type ChartLabels = {
  /** Accessible name of the chart, e.g. `Progress chart: <goal>`. */
  title: string;
  baseline: string;
  target: string;
  showData: string;
  date: string;
  value: string;
  /** Column header for notes; omit to hide notes (guardian view). */
  note?: string;
  noData: string;
};

const W = 320;
const H = 160;
const PAD = { left: 34, right: 56, top: 12, bottom: 22 };

/** Y range for the measure: fixed for percent / rating / yes-no, 0..nice max for counts. */
export function chartRange(measure: MeasureType, values: number[]): { min: number; max: number } {
  const r = VALUE_RANGES[measure];
  if (r.max !== null) return { min: r.min, max: r.max };
  const top = Math.max(1, ...values);
  const step = top <= 10 ? 2 : top <= 50 ? 10 : Math.pow(10, Math.floor(Math.log10(top)));
  return { min: 0, max: Math.ceil((top * 1.1) / step) * step };
}

/** x positions by observation date (oldest left); one point (or one date) sits in the middle. */
export function chartXs(dates: string[]): number[] {
  const inner = W - PAD.left - PAD.right;
  const times = dates.map((d) => Date.parse(`${d}T00:00:00Z`));
  const min = Math.min(...times);
  const span = Math.max(...times) - min;
  return times.map((t) => PAD.left + (span === 0 ? inner / 2 : ((t - min) / span) * inner));
}

export function ProgressChart({
  id,
  measure,
  baseline,
  target,
  baselineLabel,
  targetLabel,
  points,
  labels,
}: {
  id: string;
  measure: MeasureType;
  baseline: number;
  target: number;
  baselineLabel: string;
  targetLabel: string;
  points: ChartPoint[];
  labels: ChartLabels;
}) {
  const range = chartRange(measure, [baseline, target, ...points.map((p) => p.value)]);
  const y = (v: number) => PAD.top + (1 - (v - range.min) / (range.max - range.min || 1)) * (H - PAD.top - PAD.bottom);
  const xs = chartXs(points.map((p) => p.observed_on));
  const coords = points.map((p, i) => ({ x: xs[i], y: y(p.value), p }));
  const titleId = `${id}-title`;
  const right = W - PAD.right;

  return (
    <figure className="space-y-2" data-chart={id}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-labelledby={titleId}
        className="h-auto w-full max-w-md rounded border border-slate-200 bg-white"
      >
        <title id={titleId}>{labels.title}</title>
        <line x1={PAD.left} x2={PAD.left} y1={PAD.top} y2={H - PAD.bottom} stroke="#cbd5e1" />
        <line x1={PAD.left} x2={right} y1={H - PAD.bottom} y2={H - PAD.bottom} stroke="#cbd5e1" />
        <text x={PAD.left - 4} y={PAD.top + 4} textAnchor="end" fontSize="10" fill="#475569">
          {range.max}
        </text>
        <text x={PAD.left - 4} y={H - PAD.bottom} textAnchor="end" fontSize="10" fill="#475569">
          {range.min}
        </text>
        <line
          data-line="baseline"
          x1={PAD.left}
          x2={right}
          y1={y(baseline)}
          y2={y(baseline)}
          stroke="#64748b"
          strokeDasharray="4 3"
        />
        <text x={right + 4} y={y(baseline) + 3} fontSize="10" fill="#475569">
          {labels.baseline}
        </text>
        <line data-line="target" x1={PAD.left} x2={right} y1={y(target)} y2={y(target)} stroke="#047857" strokeDasharray="6 3" />
        <text x={right + 4} y={y(target) + 3} fontSize="10" fill="#047857">
          {labels.target}
        </text>
        {coords.length > 1 ? (
          <polyline
            data-line="progress"
            points={coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ")}
            fill="none"
            stroke="#0f766e"
            strokeWidth="2"
          />
        ) : null}
        {coords.map((c, i) => (
          <circle key={`${c.p.observed_on}-${i}`} data-point={c.p.value} cx={c.x} cy={c.y} r="3.5" fill="#0f766e" />
        ))}
        {coords.length > 0 ? (
          <>
            <text x={PAD.left} y={H - 6} fontSize="10" fill="#475569">
              {points[0].dateLabel}
            </text>
            {coords.length > 1 ? (
              <text x={right} y={H - 6} textAnchor="end" fontSize="10" fill="#475569">
                {points[points.length - 1].dateLabel}
              </text>
            ) : null}
          </>
        ) : null}
      </svg>
      <figcaption className="text-xs text-slate-600">
        {labels.baseline}: {baselineLabel} · {labels.target}: {targetLabel}
      </figcaption>
      {points.length === 0 ? (
        <p className="text-sm text-slate-600">{labels.noData}</p>
      ) : (
        <details className="text-sm">
          <summary className="inline-flex min-h-9 cursor-pointer items-center font-medium text-slate-800 underline">
            {labels.showData}
          </summary>
          <table className="mt-2 w-full max-w-md border-collapse text-left text-sm">
            <caption className="sr-only">{labels.title}</caption>
            <thead>
              <tr className="border-b border-slate-200">
                <th scope="col" className="py-1 pr-3 font-semibold">
                  {labels.date}
                </th>
                <th scope="col" className="py-1 pr-3 font-semibold">
                  {labels.value}
                </th>
                {labels.note ? (
                  <th scope="col" className="py-1 font-semibold">
                    {labels.note}
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {points.map((p, i) => (
                <tr key={`${p.observed_on}-${i}`} className="border-b border-slate-100" data-row-value={p.value}>
                  <td className="py-1 pr-3 whitespace-nowrap">{p.dateLabel}</td>
                  <td className="py-1 pr-3">{p.valueLabel}</td>
                  {labels.note ? <td className="py-1 break-words">{p.note ?? ""}</td> : null}
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </figure>
  );
}
