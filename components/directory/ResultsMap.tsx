"use client";

import { useEffect, useRef, useState } from "react";
import { useLocale, useT } from "@/lib/i18n/client";
import { clusterPoints } from "@/lib/geo/cluster";
import { importMaps, type GAdvancedMarker, type LatLngLiteral } from "@/lib/geo/maps-client";

export type MapMarker = { id: string; lat: number; lng: number; title: string; subtitle: string; href: string };

// FR-5: Google map of the current results (only rendered when a browser key is configured). Markers are
// clustered above 30 results; a cluster click zooms in, a marker click opens a small card linking the profile.
export function ResultsMap({ browserKey, mapId, origin, markers }: { browserKey: string; mapId: string; origin: LatLngLiteral; markers: MapMarker[] }) {
  const t = useT("directory.results");
  const locale = useLocale();
  const ref = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let rendered: GAdvancedMarker[] = [];
    const listeners: { remove(): void }[] = [];

    importMaps(browserKey, locale)
      .then(({ maps, marker }) => {
        if (cancelled || !ref.current) return;
        const map = new maps.Map(ref.current, {
          center: origin,
          zoom: 13,
          mapId,
          clickableIcons: false,
          streetViewControl: false,
          mapTypeControl: false,
          fullscreenControl: false,
        });
        const info = new maps.InfoWindow();

        if (markers.length) {
          const bounds = new maps.LatLngBounds();
          bounds.extend(origin);
          for (const m of markers) bounds.extend(m);
          map.fitBounds(bounds, 48);
        }

        const card = (m: MapMarker) => {
          // Built with DOM nodes (textContent), never HTML strings from profile data.
          const root = document.createElement("div");
          const name = document.createElement("a");
          name.href = m.href;
          name.textContent = m.title;
          name.style.fontWeight = "600";
          name.style.textDecoration = "underline";
          const sub = document.createElement("p");
          sub.textContent = m.subtitle;
          root.append(name, sub);
          return root;
        };

        const draw = () => {
          for (const r of rendered) r.map = null;
          rendered = [];
          for (const c of clusterPoints(markers, map.getZoom() ?? 13)) {
            if (c.items.length === 1) {
              const m = c.items[0];
              const pin = new marker.AdvancedMarkerElement({ map, position: { lat: m.lat, lng: m.lng }, title: m.title, gmpClickable: true });
              listeners.push(pin.addListener("click", () => {
                info.setContent(card(m));
                info.open({ map, anchor: pin });
              }));
              rendered.push(pin);
            } else {
              const bubble = document.createElement("div");
              bubble.textContent = String(c.items.length);
              bubble.className = "flex h-10 w-10 items-center justify-center rounded-full bg-teal-700 text-sm font-semibold text-white ring-4 ring-white/70";
              const label = t("clusterLabel", { count: c.items.length });
              const pin = new marker.AdvancedMarkerElement({ map, position: { lat: c.lat, lng: c.lng }, title: label, content: bubble, gmpClickable: true });
              listeners.push(pin.addListener("click", () => {
                map.setCenter({ lat: c.lat, lng: c.lng });
                map.setZoom((map.getZoom() ?? 13) + 2);
              }));
              rendered.push(pin);
            }
          }
        };
        listeners.push(map.addListener("zoom_changed", draw));
        draw();
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
      for (const l of listeners) l.remove();
      for (const r of rendered) r.map = null;
    };
  }, [browserKey, mapId, locale, origin, markers, t]);

  if (failed) {
    return (
      <p role="status" className="rounded border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
        {t("mapUnavailable")}
      </p>
    );
  }
  return <div ref={ref} role="region" aria-label={t("mapLabel")} className="h-[60vh] min-h-80 w-full rounded border border-slate-200 bg-slate-100 lg:sticky lg:top-4" />;
}
