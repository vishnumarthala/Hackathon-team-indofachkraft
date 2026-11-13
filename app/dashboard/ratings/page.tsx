import type { Metadata } from "next";
import { ReportRatingButton } from "@/components/ratings/ReportRatingButton";
import { RatingBadge } from "@/components/ratings/RatingBadge";
import { requireProviderPage } from "@/lib/authz";
import { getProviderContext } from "@/lib/booking/store";
import { getFormatter, getT } from "@/lib/i18n/server";
import { monthYear, ratingBadge } from "@/lib/ratings/display";
import { getRatingSummary, listProviderRatings } from "@/lib/ratings/store";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT("ratings.provider");
  return { title: `${t("metaTitle")} | DoctorNearMe`, robots: { index: false } };
}

// 036 FR-6: the provider's own ratings (published, and the ones they reported) with `Report a rating`. Never shows who
// wrote a rating (NFR-1): month/year only, like the public profile.
export default async function ProviderRatingsPage() {
  const actor = await requireProviderPage();
  const t = await getT("ratings.provider");
  const tr = await getT("ratings");
  const format = await getFormatter();
  const ctx = await getProviderContext(actor.user.id);
  const [ratings, summary] = ctx ? await Promise.all([listProviderRatings(ctx.profile.id), getRatingSummary(ctx.profile.id)]) : [[], null];

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-8">
      <h1 className="text-2xl font-semibold text-slate-900">{t("title")}</h1>
      {!ctx ? (
        <p className="text-slate-700">{t("noProfile")}</p>
      ) : (
        <>
          <RatingBadge badge={ratingBadge(summary)} t={tr} />
          <p className="text-sm text-slate-700">{t("intro")}</p>
          {ratings.length === 0 ? (
            <p className="text-slate-700">{t("none")}</p>
          ) : (
            <ul className="space-y-3" data-testid="provider-ratings">
              {ratings.map((r) => (
                <li key={r.id} className="space-y-2 rounded border border-slate-200 bg-white p-4">
                  <p className="flex flex-wrap items-center gap-2 text-sm text-slate-700">
                    <span className="font-semibold text-amber-900">{t("stars", { stars: r.stars })}</span>
                    <span>· {monthYear(r.created_at, format.locale, format.timeZone)}</span>
                    {r.reported ? <span className="rounded-full bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-900">{t("reported")}</span> : null}
                  </p>
                  {r.comment ? <p className="whitespace-pre-line text-slate-800">{r.comment}</p> : null}
                  {r.status === "published" ? <ReportRatingButton ratingId={r.id} /> : null}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
