// Ticket 029 FR-5: grid clustering for the results map (no extra dependency). Above CLUSTER_THRESHOLD markers,
// points falling into the same screen cell (about `cellPx` pixels at the current zoom) become one cluster.
import { CLUSTER_THRESHOLD } from "./constants";

export type MapPoint = { id: string; lat: number; lng: number };
export type Cluster<T extends MapPoint> = { key: string; lat: number; lng: number; items: T[] };

/** Web Mercator pixel coordinates at `zoom` (256 px tiles). */
function project(lat: number, lng: number, zoom: number): { x: number; y: number } {
  const scale = 256 * 2 ** zoom;
  const sin = Math.min(Math.max(Math.sin((lat * Math.PI) / 180), -0.9999), 0.9999);
  return {
    x: ((lng + 180) / 360) * scale,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale,
  };
}

export function clusterPoints<T extends MapPoint>(
  points: T[],
  zoom: number,
  options: { threshold?: number; cellPx?: number } = {},
): Cluster<T>[] {
  const threshold = options.threshold ?? CLUSTER_THRESHOLD;
  if (points.length <= threshold) {
    return points.map((p) => ({ key: p.id, lat: p.lat, lng: p.lng, items: [p] }));
  }
  const cell = options.cellPx ?? 60;
  const cells = new Map<string, T[]>();
  for (const p of points) {
    const { x, y } = project(p.lat, p.lng, Math.max(0, Math.round(zoom)));
    const key = `${Math.floor(x / cell)}:${Math.floor(y / cell)}`;
    const list = cells.get(key);
    if (list) list.push(p);
    else cells.set(key, [p]);
  }
  return [...cells.entries()].map(([key, items]) => ({
    key: items.length === 1 ? items[0].id : `cluster:${key}`,
    lat: items.reduce((s, p) => s + p.lat, 0) / items.length,
    lng: items.reduce((s, p) => s + p.lng, 0) / items.length,
    items,
  }));
}
