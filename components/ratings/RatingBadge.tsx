import type { TFunction } from "@/lib/i18n/keys";
import type { RatingBadge as Badge } from "@/lib/ratings/display";

// 036 FR-5: `4.6 ★ (12 ratings)` from 3 published ratings, else `New on DoctorNearMe` (D-2). Server-rendered.
export function RatingBadge({ badge, t }: { badge: Badge; t: TFunction<"ratings"> }) {
  if (badge.kind === "new") {
    return (
      <p data-testid="rating-badge" className="inline-flex items-center rounded bg-sky-50 px-2 py-1 text-sm font-semibold text-sky-900">
        {t("badge.new")}
      </p>
    );
  }
  return (
    <p
      data-testid="rating-badge"
      className="inline-flex items-center rounded bg-amber-50 px-2 py-1 text-sm font-semibold text-amber-900"
      aria-label={t("badge.averageLabel", { average: badge.average, count: badge.count })}
    >
      {t("badge.average", { average: badge.average, count: badge.count })}
    </p>
  );
}
