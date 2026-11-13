"use client";

import Link from "next/link";
import { useId, useState } from "react";
import { findHref, roundCoord } from "@/lib/geo/constants";
import type { DirectoryResult } from "@/lib/geo/search";
import { useT } from "@/lib/i18n/client";
import { SUGGESTED_PROVIDER_TYPES } from "@/lib/screen/questions";
import { primaryButton, smallButton } from "./view";

export type LocalityOption = { name: string; lat: number; lng: number };

/** Directory radius for the check-in result (the Hyderabad SEO radius of 029). */
export const NEARBY_RADIUS_KM = 25;
const PER_TYPE = 3;

type Group = { type: (typeof SUGGESTED_PROVIDER_TYPES)[number]; results: DirectoryResult[] };
type State =
  | { kind: "idle" }
  | { kind: "locating" }
  | { kind: "loading" }
  | { kind: "error"; key: "locationDenied" | "error" }
  | { kind: "done"; origin: { lat: number; lng: number }; groups: Group[] };

/** One GET /api/public/providers per suggested type (029). The location is used for these requests only. */
export async function searchSuggested(
  fetchFn: typeof fetch,
  origin: { lat: number; lng: number },
): Promise<Group[] | null> {
  try {
    const groups = await Promise.all(
      SUGGESTED_PROVIDER_TYPES.map(async (type) => {
        const params = new URLSearchParams({
          lat: String(roundCoord(origin.lat)),
          lng: String(roundCoord(origin.lng)),
          type,
          radius_km: String(NEARBY_RADIUS_KM),
        });
        const res = await fetchFn(`/api/public/providers?${params}`);
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { results: DirectoryResult[] };
        return { type, results: body.results.slice(0, PER_TYPE) };
      }),
    );
    return groups;
  } catch {
    return null;
  }
}

// Ticket 033 FR-6: `Find a specialist near you` - the 029 directory, prefiltered by the suggested provider types,
// after a location prompt. Links to profiles and the full directory only (booking from here is out of scope).
export function NearbyProviders({ localities }: { localities: LocalityOption[] }) {
  const t = useT("screen.find");
  const tp = useT("providers");
  const td = useT("directory");
  const id = useId();
  const [locality, setLocality] = useState("");
  const [state, setState] = useState<State>({ kind: "idle" });

  async function search(origin: { lat: number; lng: number }) {
    setState({ kind: "loading" });
    const groups = await searchSuggested((input, init) => fetch(input, init), origin);
    setState(groups ? { kind: "done", origin, groups } : { kind: "error", key: "error" });
  }

  function locateMe() {
    if (!navigator.geolocation) return setState({ kind: "error", key: "locationDenied" });
    setState({ kind: "locating" });
    navigator.geolocation.getCurrentPosition(
      (pos) => void search({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => setState({ kind: "error", key: "locationDenied" }),
      { enableHighAccuracy: false, timeout: 15_000, maximumAge: 600_000 },
    );
  }

  function searchLocality() {
    const hit = localities.find((l) => l.name === locality);
    if (hit) void search({ lat: hit.lat, lng: hit.lng });
  }

  const busy = state.kind === "locating" || state.kind === "loading";
  const total = state.kind === "done" ? state.groups.reduce((n, g) => n + g.results.length, 0) : 0;

  return (
    <section aria-labelledby={`${id}-title`} className="space-y-4 rounded-2xl border border-slate-200 bg-white p-4 sm:p-6" data-testid="screen-directory">
      <h2 id={`${id}-title`} className="text-xl font-semibold text-slate-900">
        {t("title")}
      </h2>
      <p className="text-slate-700">{t("intro")}</p>
      <ul className="flex flex-wrap gap-2" aria-label={t("resultsLabel")}>
        {SUGGESTED_PROVIDER_TYPES.map((type) => (
          <li key={type} data-type={type} className="rounded-full bg-teal-50 px-3 py-1 text-sm font-medium text-teal-900">
            {tp(`types.${type}`)}
          </li>
        ))}
      </ul>
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
          {state.kind === "loading" ? t("searching") : t("search")}
        </button>
      </div>
      <button type="button" className={smallButton} disabled={busy} onClick={locateMe}>
        {state.kind === "locating" ? t("locating") : t("useMyLocation")}
      </button>

      {state.kind === "error" ? (
        <p role="alert" className="text-sm font-medium text-red-700">
          {t(state.key)}
        </p>
      ) : null}

      {state.kind === "done" ? (
        <div className="space-y-5" aria-live="polite">
          {total === 0 ? <p role="status" className="text-slate-700">{t("empty")}</p> : null}
          {state.groups
            .filter((g) => g.results.length > 0)
            .map((g) => (
              <div key={g.type} className="space-y-2">
                <h3 className="font-semibold text-slate-900">{td(`typesPlural.${g.type}`)}</h3>
                <ul className="space-y-2">
                  {g.results.map((r) => (
                    <li key={r.profile_id} className="rounded-xl border border-slate-200 p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <Link href={`/p/${r.slug}`} className="font-semibold text-slate-900 underline-offset-4 hover:underline">
                          {r.display_name}
                        </Link>
                        {r.is_synthetic ? (
                          <span className="rounded bg-violet-100 px-2 py-0.5 text-xs font-semibold text-violet-900">{tp("demoBadge")}</span>
                        ) : null}
                      </div>
                      <p className="text-sm text-slate-700">
                        {[r.org_public_name && r.org_public_name !== r.display_name ? r.org_public_name : null, r.locality]
                          .filter(Boolean)
                          .join(", ")}{" "}
                        <span className="font-medium text-teal-800">
                          {r.distance_km !== null ? t("kmAway", { distance: r.distance_km.toFixed(1) }) : t("videoAnywhere")}
                        </span>
                      </p>
                    </li>
                  ))}
                </ul>
                <Link
                  href={findHref({ ...state.origin, type: g.type, radius_km: NEARBY_RADIUS_KM })}
                  className="inline-flex min-h-11 items-center text-sm font-semibold text-teal-800 underline"
                >
                  {t("seeAll", { type: td(`typesPlural.${g.type}`) })}
                </Link>
              </div>
            ))}
        </div>
      ) : null}

      <Link href="/find" className="inline-flex min-h-11 items-center text-sm font-semibold text-teal-800 underline">
        {t("openDirectory")}
      </Link>
    </section>
  );
}
