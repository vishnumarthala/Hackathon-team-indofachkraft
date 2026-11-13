import type { Metadata } from "next";
import Link from "next/link";
import { FindFilters, type FindState } from "@/components/directory/FindFilters";
import { ResultList } from "@/components/directory/ResultList";
import { ResultsLayout } from "@/components/directory/ResultsLayout";
import { BookingWidget } from "@/components/voice/BookingWidget";
import { enabledVoiceLanguages } from "@/lib/agents/call-language";
import { getAuthenticatedUser } from "@/lib/auth";
import { isDemoMode } from "@/lib/demo";
import { env } from "@/lib/env";
import { DIRECTORY_TYPES, findHref, isInIndia, typeSlug, type FindQuery } from "@/lib/geo/constants";
import { getGeocoder, KNOWN_LOCALITIES } from "@/lib/geo/geocode";
import { parseSearchQuery } from "@/lib/geo/params";
import { searchProviders, type DirectoryPage } from "@/lib/geo/search";
import { getT } from "@/lib/i18n/server";
import { turnstileSiteKey } from "@/lib/turnstile";

// Public "near me" directory (ticket 029 FR-5). Server-rendered from the URL (shareable, works without
// JavaScript); the map and Places suggestions are progressive enhancements that need the browser key.
// The searcher's location is used for this request only (D-3): it is not stored or logged.

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const t = await getT("directory");
  const hasQuery = Object.values(await searchParams).some((v) => v !== undefined && v !== "");
  return {
    title: { absolute: t("metaTitle") },
    description: t("metaDescription"),
    alternates: { canonical: `${env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "")}/find` },
    // FR-7: result pages with query parameters are not indexed; the SEO pages under /find/hyderabad are.
    robots: hasQuery ? { index: false, follow: true } : undefined,
  };
}

type Outcome =
  | { kind: "start" }
  | { kind: "invalid" }
  | { kind: "notFound" }
  | { kind: "outside" }
  | { kind: "results"; origin: { lat: number; lng: number }; label: string; data: DirectoryPage };

export default async function FindPage({ searchParams }: Props) {
  const raw = await searchParams;
  const t = await getT("directory");
  const tp = await getT("providers");
  const parsed = parseSearchQuery(raw);
  const query = parsed.success ? parsed.data : null;

  let outcome: Outcome = { kind: "start" };
  if (!query) {
    outcome = { kind: "invalid" };
  } else {
    let origin: { lat: number; lng: number } | null = null;
    let label = query.q ?? t("results.yourLocation");
    if (query.lat !== undefined && query.lng !== undefined) {
      origin = { lat: query.lat, lng: query.lng };
    } else if (query.q) {
      const hit = await getGeocoder().geocodeQuery(query.q);
      if (hit) {
        origin = { lat: hit.lat, lng: hit.lng };
        label = hit.source === "table" && hit.locality ? hit.locality : query.q;
      } else {
        outcome = { kind: "notFound" };
      }
    }
    if (origin && !isInIndia(origin.lat, origin.lng)) {
      outcome = { kind: "outside" };
    } else if (origin) {
      const data = await searchProviders({
        lat: origin.lat,
        lng: origin.lng,
        radiusKm: query.radius_km,
        type: query.type,
        language: query.language,
        mode: query.mode,
        page: query.page,
      });
      outcome = { kind: "results", origin, label, data };
    }
  }

  const initial: FindState = {
    q: query?.q ?? "",
    lat: query?.lat,
    lng: query?.lng,
    type: query?.type,
    language: query?.language,
    mode: query?.mode ?? "any",
    radius_km: query?.radius_km ?? 10,
  };
  const base: FindQuery = { ...initial, q: initial.q || undefined };
  const browserKey = env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY;
  // 034: the voice booking widget only when it can work (agent + tool secret, or the DEMO_MODE script).
  const voiceBooking = isDemoMode() || Boolean(env.ELEVENLABS_BOOKING_AGENT_ID && env.ELEVENLABS_TOOL_SECRET);
  // 051: voice needs a sign-in (searching and booking by tapping do not).
  const signedIn = voiceBooking ? Boolean(await getAuthenticatedUser().catch(() => null)) : false;
  const message = (text: string, role: "status" | "alert" = "status") => (
    <p role={role} className="rounded border border-slate-200 bg-slate-50 p-4 text-slate-800">
      {text}
    </p>
  );

  let body;
  if (outcome.kind === "invalid") body = message(t("results.invalid"), "alert");
  else if (outcome.kind === "notFound") body = message(t("results.notFound"), "alert");
  else if (outcome.kind === "outside") body = message(t("results.outsideArea"), "alert");
  else if (outcome.kind === "start") body = message(t("results.start"));
  else {
    const { data, origin, label } = outcome;
    const list = data.results.length ? (
      <ResultList results={data.results} t={t} tp={tp} />
    ) : (
      message(t("results.empty"))
    );
    const markers = data.results
      .filter((r) => r.lat !== null && r.lng !== null)
      .map((r) => ({
        id: r.profile_id,
        lat: r.lat as number,
        lng: r.lng as number,
        title: r.display_name,
        subtitle: [tp(`types.${r.provider_type}`), r.locality].filter(Boolean).join(" · "),
        href: `/p/${r.slug}`,
      }));
    body = (
      <section aria-labelledby="find-results" className="space-y-3">
        <h2 id="find-results" className="text-lg font-semibold text-slate-900">
          {t("results.near", { place: label })}
        </h2>
        {browserKey && data.results.length ? (
          <ResultsLayout browserKey={browserKey} mapId={env.NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID ?? "DEMO_MAP_ID"} origin={origin} markers={markers}>
            {list}
          </ResultsLayout>
        ) : (
          list
        )}
        {data.page > 1 || data.has_more ? (
          <nav aria-label={t("results.pagination")} className="flex items-center justify-between gap-3 pt-2">
            {data.page > 1 ? (
              <Link href={findHref({ ...base, page: data.page - 1 })} className="inline-flex min-h-11 items-center font-medium text-slate-900 underline">
                {t("results.previous")}
              </Link>
            ) : (
              <span />
            )}
            <span className="text-sm text-slate-600">{t("results.page", { page: data.page })}</span>
            {data.has_more ? (
              <Link href={findHref({ ...base, page: data.page + 1 })} className="inline-flex min-h-11 items-center font-medium text-slate-900 underline">
                {t("results.next")}
              </Link>
            ) : (
              <span />
            )}
          </nav>
        ) : null}
      </section>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-8">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold text-slate-900">{t("title")}</h1>
        <p className="text-slate-700">{t("intro")}</p>
      </header>
      {voiceBooking ? (
        <BookingWidget signedIn={signedIn} turnstileSiteKey={turnstileSiteKey()} voiceLanguages={enabledVoiceLanguages("booking")} />
      ) : null}
      <FindFilters
        key={JSON.stringify(initial)}
        initial={initial}
        browserKey={browserKey}
        localities={browserKey ? [] : [...KNOWN_LOCALITIES]}
      />
      {body}
      <nav aria-labelledby="find-browse" className="space-y-2 border-t border-slate-200 pt-6">
        <h2 id="find-browse" className="text-base font-semibold text-slate-900">
          {t("browse.title")}
        </h2>
        <ul className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
          {DIRECTORY_TYPES.map((type) => (
            <li key={type}>
              <Link href={`/find/hyderabad/${typeSlug(type)}`} className="inline-flex min-h-11 items-center text-slate-800 underline">
                {t(`typesPlural.${type}`)}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}
