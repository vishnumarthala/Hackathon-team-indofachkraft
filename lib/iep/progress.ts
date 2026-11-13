// Ticket 025 FR-7: progress summary of one goal. Pure (browser safe).
//
// goalTrend(points, goal):
// - latest: value of the most recent observation (by observed_on, then created_at), null without points.
// - change_from_baseline: latest - baseline (signed, in the measure's unit), null without points.
// - percent_to_target: share of the baseline -> target distance covered by `latest`, rounded, clamped to 0-100
//   (works for decreasing targets, e.g. fewer meltdowns: baseline 10, target 2, latest 6 -> 50).
// - on_track: null with fewer than 2 points. Otherwise true when the latest value has reached the target, or when
//   the least-squares slope of the last 5 observations (in observation order) points towards the target;
//   false when it is flat or moving away.

export type ProgressPoint = { observed_on: string; value: number; created_at?: string | null };
export type TrendGoal = { baseline_value: number; target_value: number };
export type GoalTrend = {
  latest: number | null;
  change_from_baseline: number | null;
  percent_to_target: number | null;
  on_track: boolean | null;
};

export const TREND_WINDOW = 5;

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Observations oldest first (observed_on, then created_at). Does not mutate the input. */
export function sortPoints<T extends ProgressPoint>(points: readonly T[]): T[] {
  return [...points].sort(
    (a, b) => a.observed_on.localeCompare(b.observed_on) || String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")),
  );
}

function slope(values: number[]): number {
  const n = values.length;
  const meanX = (n - 1) / 2;
  const meanY = values.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let den = 0;
  values.forEach((v, i) => {
    num += (i - meanX) * (v - meanY);
    den += (i - meanX) ** 2;
  });
  return den === 0 ? 0 : num / den;
}

export function goalTrend(points: readonly ProgressPoint[], goal: TrendGoal): GoalTrend {
  if (points.length === 0) return { latest: null, change_from_baseline: null, percent_to_target: null, on_track: null };
  const ordered = sortPoints(points);
  const latest = Number(ordered[ordered.length - 1].value);
  const baseline = Number(goal.baseline_value);
  const target = Number(goal.target_value);
  const distance = target - baseline;
  const direction = Math.sign(distance);
  const covered = distance === 0 ? 100 : ((latest - baseline) / distance) * 100;
  const percent = Math.round(Math.min(100, Math.max(0, covered)));

  let onTrack: boolean | null = null;
  if (ordered.length >= 2) {
    const reached = direction === 0 || (direction > 0 ? latest >= target : latest <= target);
    const recent = ordered.slice(-TREND_WINDOW).map((p) => Number(p.value));
    onTrack = reached || Math.sign(round2(slope(recent))) === direction;
  }
  return { latest, change_from_baseline: round2(latest - baseline), percent_to_target: percent, on_track: onTrack };
}
