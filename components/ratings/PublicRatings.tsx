import type { TFunction } from "@/lib/i18n/keys";
import type { Locale } from "@/lib/i18n/config";
import { monthYear } from "@/lib/ratings/display";
import type { PublicComment } from "@/lib/ratings/store";

// 036 FR-5 / NFR-1: the profile's rating comments (the aggregate badge sits in the header): the latest published comments with `Verified booking`
// and the month/year only (no names, no stars per comment, no visit details).
export function PublicRatings({
  comments,
  t,
  locale,
  timeZone,
}: {
  comments: PublicComment[];
  t: TFunction<"ratings">;
  locale: Locale;
  timeZone: string;
}) {
  return (
    <section aria-labelledby="ratings-heading" className="space-y-3">
      <h2 id="ratings-heading" className="text-lg font-semibold text-slate-900">
        {t("public.title")}
      </h2>
      <p className="text-sm text-slate-600">{t("public.intro")}</p>
      {comments.length ? (
        <ul className="space-y-3" data-testid="rating-comments">
          {comments.map((c) => (
            <li key={c.id} className="rounded border border-slate-200 bg-white p-3">
              <p className="whitespace-pre-line text-slate-800">{c.comment}</p>
              <p className="mt-1 text-xs text-slate-600">
                <span className="font-semibold text-teal-800">✓ {t("public.verified")}</span> · {monthYear(c.created_at, locale, timeZone)}
              </p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-slate-600">{t("public.noComments")}</p>
      )}
    </section>
  );
}
