"use client";

import { useState, useSyncExternalStore, type ReactNode } from "react";
import { useT } from "@/lib/i18n/client";
import type { LatLngLiteral } from "@/lib/geo/maps-client";
import { ResultsMap, type MapMarker } from "./ResultsMap";

const DESKTOP = "(min-width: 1024px)";

function useDesktop(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const query = window.matchMedia(DESKTOP);
      query.addEventListener("change", onChange);
      return () => query.removeEventListener("change", onChange);
    },
    () => window.matchMedia(DESKTOP).matches,
    () => false,
  );
}

// FR-5: list + map side by side on desktop; a `Map` / `List` toggle on mobile. Without a browser key the
// parent renders the list alone (no toggle, no Google request).
export function ResultsLayout({
  browserKey,
  mapId,
  origin,
  markers,
  children,
}: {
  browserKey: string;
  mapId: string;
  origin: LatLngLiteral;
  markers: MapMarker[];
  children: ReactNode;
}) {
  const t = useT("directory.results");
  const [view, setView] = useState<"list" | "map">("list");
  const desktop = useDesktop();

  const toggle = (value: "list" | "map", label: string) => (
    <button
      type="button"
      aria-pressed={view === value}
      onClick={() => setView(value)}
      className={`min-h-11 flex-1 rounded px-4 py-2 text-sm font-medium ${view === value ? "bg-teal-700 text-white" : "bg-white text-slate-800"}`}
    >
      {label}
    </button>
  );

  // The map mounts only when visible (desktop, or mobile in map view): no Google request for list-only use.
  const showMap = desktop || view === "map";
  return (
    <div className="space-y-3">
      <div role="group" aria-label={t("view")} className="flex gap-1 rounded border border-slate-300 bg-slate-100 p-1 lg:hidden">
        {toggle("list", t("list"))}
        {toggle("map", t("map"))}
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className={view === "map" ? "hidden lg:block" : undefined}>{children}</div>
        {showMap ? (
          <div className={view === "list" ? "hidden lg:block" : undefined}>
            <ResultsMap browserKey={browserKey} mapId={mapId} origin={origin} markers={markers} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
