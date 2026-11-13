"use client";

import Link from "next/link";
import { useEffect, useId, useState } from "react";
import { dayLabel, viewerDate } from "@/lib/booking/display";
import { useFormatter, useLocale, useT, useTimeZone } from "@/lib/i18n/client";
import { fetchMatches } from "@/lib/screen/client";
import type { MatchResponse, MatchSlot } from "@/lib/screen/matches";
import { primaryButton, smallButton } from "./view";

export type LocalityOption = { name: string; lat: number; lng: number };

type Origin = { lat: number; lng: number; label: string | null };
type State =
  | { kind: "loading"; origin: Origin | null }
  | { kind: "locating" }
  | { kind: "error"; key: "locationDenied" | "error" }
  | { kind: "done"; origin: Origin | null; data: MatchResponse };

// Ticket 048 FR-10 (replaces 033's per-type lists): up to 3 matching providers below the recommendation, ordered by
// recommended type then distance (central Hyderabad until the parent picks an area or shares the location, which
// is used for that request only). Each shows its next 2 free times; a time goes straight to /book with that slot
// selected. `See more` opens /find with the same filters.
export function NearbyProviders({ sessionId, localities }: { sessionId: string; localities: LocalityOption[] }) {
  const t = useT("screen.find");
  const tp = useT("providers");
  const format = useFormatter();
  const locale = useLocale();
  const viewerTz = useTimeZone();
  const id = useId();
  const [locality, setLocality] = useState("");
  const [request, setRequest] = useState<{ origin: Origin | null; n: number }>({ origin: null, n: 0 });
  const [state, setState] = useState<State>({ kind: "loading", origin: null });

  useEffect(() => {
    let cancelled = false;
    fetchMatches((input, init) => fetch(input, init), sessionId, request.origin).then((data) => {
      if (cancelled) return;
      setState(data ? { kind: "done", origin: request.origin, data } : { kind: "error", key: "error" });
    });
    return () => {
      cancelled = true;
    };
  }, [sessionId, request]);

  function search(origin: Origin) {
    setState({ kind: "loading", origin });
    setRequest((r) => ({ origin, n: r.n + 1 }));
  }

  function locateMe() {
    if (!navigator.geolocation) return setState({ kind: "error", key: "locationDenied" });
    setState({ kind: "locating" });
    navigator.geolocation.getCurrentPosition(
      (pos) => search({ lat: pos.coords.latitude, lng: pos.coords.longitude, label: null }),
      () => setState({ kind: "error", key: "locationDenied" }),
      { enableHighAccuracy: false, timeout: 15_000, maximumAge: 600_000 },
    );
  }

  function searchLocality() {
    const hit = localities.find((l) => l.name === locality);
    if (hit) search({ lat: hit.lat, lng: hit.lng, label: hit.name });
  }

  const chipLabel = (slot: MatchSlot) => {
    const day = dayLabel(viewerDate(slot.start, viewerTz), locale);
    return `${day.weekday} ${day.day}, ${format.time(slot.start)}`;
  };
  const busy = state.kind === "locating" || state.kind === "loading";
  const origin = state.kind === "done" || state.kind === "loading" ? state.origin : null;

  return (
    <section aria-labelledby={`${id}-title`} className="space-y-4 rounded-2xl border border-slate-200 bg-white p-4 sm:p-6" data-testid="screen-directory">
      <h2 id={`${id}-title`} className="text-xl font-semibold text-slate-900">
        {t("title")}
      </h2>
      <p className="text-slate-700">{origin ? t("introPlace", { place: origin.label ?? t("yourLocation") }) : t("introDefault")}</p>

      <div aria-live="polite" className="space-y-3">
        {state.kind === "loading" ? <p role="status" className="text-slate-700">{t("loading")}</p> : null}
        {state.kind === "error" ? (
          <p role="alert" className="text-sm font-medium text-red-700">
            {t(state.key)}
          </p>
        ) : null}
        {state.kind === "done" && state.data.providers.length === 0 ? <p role="status" className="text-slate-700">{t("empty")}</p> : null}
        {state.kind === "done" && state.data.providers.length > 0 ? (
          <>
            <p className="text-sm text-slate-700">{t("bookHint")}</p>
            <ul className="space-y-3">
              {state.data.providers.map((p) => (
                <li key={p.profile_id} className="space-y-2 rounded-xl border border-slate-200 p-3" data-profile={p.profile_id} data-type={p.provider_type}>
                  <div className="flex flex-wrap items-center gap-2">
                    <Link href={`/p/${p.slug}`} className="font-semibold text-slate-900 underline-offset-4 hover:underline">
                      {p.display_name}
                    </Link>
                    {p.is_synthetic ? (
                      <span className="rounded bg-violet-100 px-2 py-0.5 text-xs font-semibold text-violet-900">{tp("demoBadge")}</span>
                    ) : null}
                  </div>
                  <p className="text-sm text-slate-700">
                    {tp(`types.${p.provider_type}`)}
                    {" · "}
                    {[p.org_public_name && p.org_public_name !== p.display_name ? p.org_public_name : null, p.locality].filter(Boolean).join(", ")}{" "}
                    <span className="font-medium text-teal-800">
                      {p.distance_km !== null ? t("kmAway", { distance: p.distance_km.toFixed(1) }) : t("videoAnywhere")}
                    </span>
                  </p>
                  {p.slots.length > 0 ? (
                    <ul className="flex flex-wrap gap-2" aria-label={t("slotsLabel", { name: p.display_name })}>
                      {p.slots.map((s) => (
                        <li key={s.start}>
                          <Link
                            href={s.book_href}
                            data-testid="screen-slot"
                            className="inline-flex min-h-11 items-center rounded-full border border-teal-700 bg-white px-4 text-sm font-semibold text-teal-900 hover:bg-teal-50 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-600/30"
                          >
                            {chipLabel(s)}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-slate-600">
                      {t("noSlots")}{" "}
                      <Link href={`/p/${p.slug}`} className="font-semibold text-teal-800 underline">
                        {t("viewProfile")}
                      </Link>
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </div>

      <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
        <div>
          <label htmlFor={`${id}-locality`} className="mb-1 block text-sm font-semibold text-slate-800">
            {t("locality")}
          </label>
          <select
            id={`${id}-locality`}
            value={locality}
            onChange={(e) => setLocality(e.target.value)}
            className="min-h-12 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-base"
          >
            <option value="">{t("chooseLocality")}</option>
            {localities.map((l) => (
              <option key={l.name} value={l.name}>
                {l.name}
              </option>
            ))}
          </select>
        </div>
        <button type="button" className={primaryButton} disabled={!locality || busy} onClick={searchLocality}>
          {state.kind === "loading" && origin ? t("searching") : t("search")}
        </button>
      </div>
      <button type="button" className={smallButton} disabled={busy} onClick={locateMe}>
        {state.kind === "locating" ? t("locating") : t("useMyLocation")}
      </button>

      <div className="flex flex-wrap gap-x-6">
        {state.kind === "done" ? (
          <Link href={state.data.see_more} className="inline-flex min-h-11 items-center text-sm font-semibold text-teal-800 underline">
            {t("seeMore")}
          </Link>
        ) : null}
        <Link href="/find" className="inline-flex min-h-11 items-center text-sm font-semibold text-teal-800 underline">
          {t("openDirectory")}
        </Link>
      </div>
    </section>
  );
}
