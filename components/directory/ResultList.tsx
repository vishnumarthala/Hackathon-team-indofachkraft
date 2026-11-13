import Link from "next/link";
import { DemoBadge } from "@/components/providers/PublicProfile";
import type { TFunction } from "@/lib/i18n/keys";
import type { DirectoryResult } from "@/lib/geo/search";

// Server-rendered result cards for /find and /find/hyderabad/<type> (ticket 029 FR-5). Public fields only.

export function formatDistance(km: number): string {
  return km.toFixed(1);
}

export function ResultCard({ r, t, tp }: { r: DirectoryResult; t: TFunction<"directory">; tp: TFunction<"providers"> }) {
  const modes = [r.offers_in_clinic ? t("modes.in_clinic") : null, r.offers_video ? t("modes.video") : null].filter(Boolean);
  return (
    <li className="space-y-2 rounded border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Link href={`/p/${r.slug}`} className="text-lg font-semibold text-slate-900 underline-offset-4 hover:underline">
          {r.display_name}
        </Link>
        {r.is_synthetic ? <DemoBadge t={tp} /> : null}
      </div>
      <p className="text-sm text-slate-700">{tp(`types.${r.provider_type}`)}</p>
      <p className="text-sm text-slate-700">
        {[
          r.org_public_name && r.org_public_name !== r.display_name ? r.org_public_name : null,
          r.locality,
        ]
          .filter(Boolean)
          .join(", ")}
        {r.distance_km !== null ? (
          <span className="ml-2 font-medium text-teal-800">{t("results.kmAway", { distance: formatDistance(r.distance_km) })}</span>
        ) : (
          <span className="ml-2 font-medium text-teal-800">{t("results.videoAnywhere")}</span>
        )}
      </p>
      <dl className="grid gap-1 text-sm text-slate-700 sm:grid-cols-2">
        {r.languages.length ? (
          <div>
            <dt className="inline font-medium text-slate-900">{t("results.languages")}: </dt>
            <dd className="inline">{r.languages.map((l) => tp(`languages.${l as "en"}`)).join(", ")}</dd>
          </div>
        ) : null}
        {modes.length ? (
          <div>
            <dt className="inline font-medium text-slate-900">{t("results.consultation")}: </dt>
            <dd className="inline">{modes.join(", ")}</dd>
          </div>
        ) : null}
      </dl>
      <div className="flex flex-wrap items-center gap-3">
        <Link href={`/p/${r.slug}`} className="inline-flex min-h-11 items-center rounded border border-slate-300 px-4 text-sm font-medium text-slate-900 hover:bg-slate-50">
          {t("results.viewProfile")}
        </Link>
        {/* 030: consultation modes are derived from active services; the booking page explains when none is bookable. */}
        {r.offers_in_clinic || r.offers_video ? (
          <Link href={`/book/${r.profile_id}`} className="inline-flex min-h-11 items-center rounded bg-slate-900 px-4 text-sm font-medium text-white hover:bg-slate-700">
            {t("results.book")}
          </Link>
        ) : (
          <>
            <button type="button" disabled aria-describedby={`book-soon-${r.profile_id}`} className="min-h-11 rounded bg-slate-900 px-4 text-sm font-medium text-white opacity-50">
              {t("results.book")}
            </button>
            <span id={`book-soon-${r.profile_id}`} className="text-xs text-slate-600">
              {t("results.bookSoon")}
            </span>
          </>
        )}
      </div>
    </li>
  );
}

export function ResultList({ results, t, tp }: { results: DirectoryResult[]; t: TFunction<"directory">; tp: TFunction<"providers"> }) {
  return (
    <ul className="space-y-3">
      {results.map((r) => (
        <ResultCard key={r.profile_id} r={r} t={t} tp={tp} />
      ))}
    </ul>
  );
}
