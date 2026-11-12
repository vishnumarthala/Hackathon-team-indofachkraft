"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useLocale, useT } from "@/lib/i18n/client";
import { findHref, HYDERABAD_CENTRE, RADIUS_OPTIONS, roundCoord, type DirectoryType, type SearchMode } from "@/lib/geo/constants";
import { importPlaces, type PlacePrediction } from "@/lib/geo/maps-client";
import { PROFILE_LANGUAGES, PROVIDER_TYPES } from "@/lib/providers/constants";
import { buttonClass, inputClass, labelClass, secondaryButtonClass } from "@/components/providers/request";

export type FindState = {
  q: string;
  lat?: number;
  lng?: number;
  type?: DirectoryType;
  language?: string;
  mode: SearchMode;
  radius_km: number;
};

type Suggestion = { id: string; label: string; prediction: PlacePrediction };

// FR-5 search form. Works without JavaScript (GET /find?q=...; the server geocodes the text). With JavaScript:
// `Use my location` (browser geolocation, rounded to ~100 m, kept only in the URL) and, when a browser key is
// configured, Google Places suggestions restricted to India. Without a key, a list of known Hyderabad
// localities is offered instead.
export function FindFilters({ initial, browserKey, localities }: { initial: FindState; browserKey?: string; localities: string[] }) {
  const t = useT("directory");
  const tp = useT("providers");
  const locale = useLocale();
  const router = useRouter();
  const listId = useId();
  const [state, setState] = useState<FindState>(initial);
  const [locating, setLocating] = useState(false);
  const [geoError, setGeoError] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [active, setActive] = useState(-1);
  const sessionToken = useRef<object | null>(null);
  const hasLocation = (s: FindState) => (s.lat !== undefined && s.lng !== undefined) || s.q.trim() !== "";

  function go(next: FindState) {
    const located = next.lat !== undefined && next.lng !== undefined;
    router.push(
      findHref({
        lat: located ? next.lat : undefined,
        lng: located ? next.lng : undefined,
        q: next.q.trim() || undefined,
        radius_km: next.radius_km,
        type: next.type,
        language: next.language,
        mode: next.mode,
      }),
    );
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSuggestions([]);
    go(state);
  }

  function setFilter(patch: Partial<FindState>) {
    const next = { ...state, ...patch };
    setState(next);
    if (hasLocation(next)) go(next);
  }

  function locateMe() {
    if (!("geolocation" in navigator)) {
      setGeoError(true);
      return;
    }
    setLocating(true);
    setGeoError(false);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        // D-3: only a rounded position goes into the URL; nothing is stored server-side.
        const next = { ...state, q: "", lat: roundCoord(pos.coords.latitude), lng: roundCoord(pos.coords.longitude) };
        setState(next);
        go(next);
      },
      () => {
        setLocating(false);
        setGeoError(true);
      },
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 300_000 },
    );
  }

  // Google Places suggestions (browser key only), debounced.
  const query = state.q.trim();
  const typedSinceSelection = state.lat === undefined;
  useEffect(() => {
    if (!browserKey || !typedSinceSelection || query.length < 3) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const places = await importPlaces(browserKey, locale);
        sessionToken.current ??= new places.AutocompleteSessionToken();
        const { suggestions: found } = await places.AutocompleteSuggestion.fetchAutocompleteSuggestions({
          input: query,
          includedRegionCodes: ["in"],
          locationBias: { center: HYDERABAD_CENTRE, radius: 30_000 },
          language: locale,
          sessionToken: sessionToken.current,
        });
        if (cancelled) return;
        setSuggestions(
          found
            .map((s, i) => (s.placePrediction ? { id: `${listId}-${i}`, label: s.placePrediction.text.toString(), prediction: s.placePrediction } : null))
            .filter((s): s is Suggestion => s !== null)
            .slice(0, 5),
        );
        setActive(-1);
      } catch {
        if (!cancelled) setSuggestions([]);
      }
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [browserKey, locale, query, typedSinceSelection, listId]);

  async function choose(s: Suggestion) {
    setSuggestions([]);
    try {
      const place = s.prediction.toPlace();
      await place.fetchFields({ fields: ["location", "displayName"] });
      sessionToken.current = null;
      if (!place.location) return;
      const next = { ...state, q: s.label, lat: roundCoord(place.location.lat()), lng: roundCoord(place.location.lng()) };
      setState(next);
      go(next);
    } catch {
      // Fall back to the typed text, geocoded on the server.
      const next = { ...state, q: s.label, lat: undefined, lng: undefined };
      setState(next);
      go(next);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (!suggestions.length) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((i) => (i + 1) % suggestions.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
    } else if (event.key === "Enter" && active >= 0) {
      event.preventDefault();
      void choose(suggestions[active]);
    } else if (event.key === "Escape") {
      setSuggestions([]);
    }
  }

  const radiusOptions = [...new Set<number>([...RADIUS_OPTIONS, state.radius_km])].sort((a, b) => a - b);
  const open = suggestions.length > 0;

  return (
    <form action="/find" method="get" onSubmit={onSubmit} role="search" aria-label={t("filters.legend")} className="space-y-4 rounded border border-slate-200 bg-white p-4">
      <div>
        <label htmlFor="find-q" className={labelClass}>
          {t("filters.location")}
        </label>
        <div className="mt-1 flex flex-col gap-2 sm:flex-row">
          <div className="relative flex-1">
            <input
              id="find-q"
              name="q"
              type="search"
              autoComplete="off"
              maxLength={100}
              value={state.q}
              placeholder={t("filters.locationHint")}
              onChange={(e) => setState({ ...state, q: e.target.value, lat: undefined, lng: undefined })}
              onKeyDown={onKeyDown}
              onBlur={() => window.setTimeout(() => setSuggestions([]), 150)}
              list={browserKey ? undefined : `${listId}-localities`}
              role={browserKey ? "combobox" : undefined}
              aria-autocomplete={browserKey ? "list" : undefined}
              aria-expanded={browserKey ? open : undefined}
              aria-controls={browserKey ? `${listId}-list` : undefined}
              aria-activedescendant={open && active >= 0 ? suggestions[active].id : undefined}
              className={`${inputClass} mt-0`}
            />
            {browserKey ? (
              <ul
                id={`${listId}-list`}
                role="listbox"
                aria-label={t("filters.suggestions")}
                hidden={!open}
                className="absolute z-20 mt-1 w-full overflow-hidden rounded border border-slate-300 bg-white shadow-lg"
              >
                {suggestions.map((s, i) => (
                  <li
                    key={s.id}
                    id={s.id}
                    role="option"
                    aria-selected={i === active}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      void choose(s);
                    }}
                    className={`cursor-pointer px-3 py-2 text-sm ${i === active ? "bg-slate-100" : ""}`}
                  >
                    {s.label}
                  </li>
                ))}
              </ul>
            ) : (
              <datalist id={`${listId}-localities`}>
                {localities.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
            )}
          </div>
          <button type="button" onClick={locateMe} disabled={locating} className={secondaryButtonClass}>
            {locating ? t("filters.locating") : t("filters.useMyLocation")}
          </button>
        </div>
        {geoError ? (
          <p role="alert" className="mt-1 text-sm text-red-700">
            {t("filters.locationDenied")}
          </p>
        ) : null}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <label htmlFor="find-type" className={labelClass}>
            {t("filters.specialty")}
          </label>
          <select
            id="find-type"
            name="type"
            value={state.type ?? ""}
            onChange={(e) => setFilter({ type: (e.target.value || undefined) as DirectoryType | undefined })}
            className={inputClass}
          >
            <option value="">{t("filters.anySpecialty")}</option>
            {PROVIDER_TYPES.map((type) => (
              <option key={type} value={type}>
                {tp(`types.${type}`)}
              </option>
            ))}
            <option value="centre">{t("filters.centres")}</option>
          </select>
        </div>
        <div>
          <label htmlFor="find-language" className={labelClass}>
            {t("filters.language")}
          </label>
          <select id="find-language" name="language" value={state.language ?? ""} onChange={(e) => setFilter({ language: e.target.value || undefined })} className={inputClass}>
            <option value="">{t("filters.anyLanguage")}</option>
            {PROFILE_LANGUAGES.map((lang) => (
              <option key={lang} value={lang}>
                {tp(`languages.${lang}`)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="find-mode" className={labelClass}>
            {t("filters.consultation")}
          </label>
          <select id="find-mode" name="mode" value={state.mode} onChange={(e) => setFilter({ mode: e.target.value as SearchMode })} className={inputClass}>
            <option value="in_clinic">{t("modes.in_clinic")}</option>
            <option value="video">{t("modes.video")}</option>
            <option value="any">{t("modes.any")}</option>
          </select>
        </div>
        <div>
          <label htmlFor="find-radius" className={labelClass}>
            {t("filters.distance")}
          </label>
          <select id="find-radius" name="radius_km" value={state.radius_km} onChange={(e) => setFilter({ radius_km: Number(e.target.value) })} className={inputClass}>
            {radiusOptions.map((km) => (
              <option key={km} value={km}>
                {t("filters.distanceOption", { km })}
              </option>
            ))}
          </select>
        </div>
      </div>
      <button type="submit" className={buttonClass}>
        {t("filters.search")}
      </button>
    </form>
  );
}
