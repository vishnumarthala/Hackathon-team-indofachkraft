import type { Metadata } from "next";
import Link from "next/link";
import { AdminNav } from "@/components/admin/AdminNav";
import { ModerationActions } from "@/components/ratings/ModerationActions";
import { requirePlatformAdminPage } from "@/lib/authz";
import { getFormatter, getT } from "@/lib/i18n/server";
import { RATING_STATUSES, type RatingStatus } from "@/lib/ratings/rules";
import { countPendingRatings, listRatingsForAdmin } from "@/lib/ratings/store";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT("ratings.admin");
  return { title: t("metaTitle"), robots: { index: false } };
}

const TABS: RatingStatus[] = ["pending_review", "published", "hidden"];

// 036 FR-6: the `pending_review` queue (abuse-list matches and provider reports) plus published / hidden ratings, with
// `Publish` / `Hide` (note required to hide, audited). NFR-1: the guardian's identity is shown here only. Other roles 404.
export default async function AdminRatingsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  await requirePlatformAdminPage();
  const { status: raw } = await searchParams;
  const status: RatingStatus = RATING_STATUSES.includes(raw as RatingStatus) ? (raw as RatingStatus) : "pending_review";
  const t = await getT("ratings.admin");
  const format = await getFormatter();
  const [ratings, pending] = await Promise.all([listRatingsForAdmin(status), countPendingRatings()]);

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-6">
      <AdminNav current="ratings" />
      <h1 className="text-2xl font-semibold text-slate-900">{t("title")}</h1>
      <nav aria-label={t("title")} className="flex flex-wrap gap-2">
        {TABS.map((s) => (
          <Link
            key={s}
            href={`/admin/ratings?status=${s}`}
            aria-current={s === status ? "page" : undefined}
            className={`inline-flex min-h-11 items-center rounded border px-4 text-sm font-medium ${s === status ? "border-slate-900 bg-slate-900 text-white" : "border-slate-300 bg-white text-slate-800"}`}
          >
            {t(`tabs.${s}`)}
            {s === "pending_review" ? ` (${format.number(pending)})` : ""}
          </Link>
        ))}
      </nav>
      {ratings.length === 0 ? (
        <p className="text-slate-700">{t("none")}</p>
      ) : (
        <ul className="space-y-4" data-testid="admin-ratings">
          {ratings.map((r) => (
            <li key={r.id} className="space-y-3 rounded border border-slate-200 bg-white p-4" data-rating-id={r.id}>
              <p className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-semibold text-amber-900">{t("stars", { stars: r.stars })}</span>
                <span className="text-slate-600">{format.dateTime(r.created_at)}</span>
                {r.status === "pending_review" && r.review_reason ? (
                  <span className="rounded-full bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-900">{t(`reason.${r.review_reason}`)}</span>
                ) : null}
              </p>
              <p className="whitespace-pre-line break-words text-slate-800">{r.comment ?? <span className="text-slate-500">{t("noComment")}</span>}</p>
              <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                <div>
                  <dt className="font-semibold text-slate-900">{t("provider")}</dt>
                  <dd>
                    <Link href={`/p/${r.provider_slug}`} className="underline">
                      {r.provider_name}
                    </Link>
                  </dd>
                </div>
                <div>
                  <dt className="font-semibold text-slate-900">{t("guardian")}</dt>
                  <dd className="break-words">{[r.guardian_name, r.guardian_email].filter(Boolean).join(" · ")}</dd>
                </div>
                {r.report_reason ? (
                  <div className="sm:col-span-2">
                    <dt className="font-semibold text-slate-900">{t("reportReason")}</dt>
                    <dd className="whitespace-pre-line break-words">{r.report_reason}</dd>
                  </div>
                ) : null}
                {r.moderation_note ? (
                  <div className="sm:col-span-2">
                    <dt className="font-semibold text-slate-900">{t("lastNote")}</dt>
                    <dd className="whitespace-pre-line break-words">{r.moderation_note}</dd>
                  </div>
                ) : null}
              </dl>
              <ModerationActions ratingId={r.id} status={r.status} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
