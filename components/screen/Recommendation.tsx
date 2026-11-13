"use client";

import Link from "next/link";
import { findHref, HYDERABAD_CENTRE, SEO_RADIUS_KM } from "@/lib/geo/constants";
import { useT } from "@/lib/i18n/client";
import type { Recommendation as RecommendationData } from "@/lib/screen/recommend";
import { reasonKey } from "./view";

// Ticket 048 FR-6: the recommended kinds of professional, in order. The first card says why in one sentence
// ("Because you mentioned speech, a speech therapist is a good first step"); each card opens /find prefiltered.
export function Recommendation({ recommendation }: { recommendation: RecommendationData }) {
  const t = useT("screen.recommend");
  const tp = useT("providers");
  const [first] = recommendation.types;
  return (
    <section aria-labelledby="screen-recommend-title" className="space-y-3" data-testid="screen-recommend">
      <h2 id="screen-recommend-title" className="text-xl font-semibold text-slate-900">
        {t("title")}
      </h2>
      <ol className="space-y-3">
        {recommendation.types.map((type, i) => (
          <li
            key={type}
            data-type={type}
            className={`space-y-1 rounded-2xl border p-4 ${i === 0 ? "border-teal-600 bg-teal-50" : "border-slate-200 bg-white"}`}
          >
            {i === 0 ? (
              <p className="text-sm font-semibold text-teal-800">{t("first")}</p>
            ) : null}
            <h3 className="text-lg font-semibold text-slate-900">{tp(`types.${type}`)}</h3>
            {i === 0 ? (
              <p className="font-medium text-slate-900" data-testid="screen-recommend-reason">
                {t(`reasons.${reasonKey(recommendation.reason, first)}`)}
              </p>
            ) : null}
            <p className="text-sm text-slate-700">{t(`roles.${type}`)}</p>
            <Link
              href={findHref({ ...HYDERABAD_CENTRE, type, radius_km: SEO_RADIUS_KM })}
              className="inline-flex min-h-11 items-center text-sm font-semibold text-teal-800 underline underline-offset-4"
            >
              {t("findType")}
              <span className="sr-only">: {tp(`types.${type}`)}</span>
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}
