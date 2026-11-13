"use client";

import Link from "next/link";
import { findHref, HYDERABAD_CENTRE, SEO_RADIUS_KM } from "@/lib/geo/constants";
import { useT } from "@/lib/i18n/client";
import type { ProviderType } from "@/lib/providers/constants";
import { MILESTONES } from "@/lib/screen/milestones";
import { OVER_8_TYPES, UNDER_18M_TYPES } from "@/lib/screen/recommend";

const linkClass = "inline-flex min-h-11 items-center font-semibold text-teal-800 underline underline-offset-4";
const findType = (type: ProviderType) => findHref({ ...HYDERABAD_CENTRE, type, radius_km: SEO_RADIUS_KM });

// Ticket 048 FR-2: under 18 months there are no questions, only plain milestone guidance (static list, pending
// clinical review) and "talk to your paediatrician" with /find prefiltered for paediatricians.
export function Under18Guidance() {
  const t = useT("screen.under18m");
  const tp = useT("providers");
  return (
    <section aria-labelledby="screen-under18m-title" className="space-y-4 rounded-2xl border border-slate-200 bg-white p-4 sm:p-6" data-testid="screen-under18m">
      <h2 id="screen-under18m-title" className="text-xl font-semibold text-slate-900">
        {t("title")}
      </h2>
      <p className="text-slate-800">{t("intro")}</p>
      <ul className="space-y-2">
        {MILESTONES.map((m) => (
          <li key={m.key} className="rounded-xl bg-slate-50 px-3 py-2" data-milestone={m.key}>
            <span className="font-medium text-slate-900">{t(`milestones.${m.key}`)}</span>{" "}
            <span className="text-slate-700">({t("byMonths", { months: m.byMonths })})</span>
          </li>
        ))}
      </ul>
      <p className="rounded-xl bg-amber-50 p-3 text-sm font-medium text-amber-900">{t("lostSkills")}</p>
      <p className="font-medium text-slate-900">{t("advice")}</p>
      <ul className="flex flex-col gap-1 sm:flex-row sm:gap-6">
        {UNDER_18M_TYPES.map((type) => (
          <li key={type}>
            <Link href={findType(type)} className={linkClass} data-type={type}>
              {type === "pediatrician" ? t("findPaediatrician") : t("findDevPaed")}
            </Link>
            <span className="sr-only"> ({tp(`types.${type}`)})</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// Ticket 048 FR-1: 9 years or older: no check-in, a short note and the directory.
export function Over8Notice() {
  const t = useT("screen.over8");
  const tf = useT("screen.find");
  return (
    <section aria-labelledby="screen-over8-title" className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4 sm:p-6" data-testid="screen-over8">
      <h2 id="screen-over8-title" className="text-xl font-semibold text-slate-900">
        {t("title")}
      </h2>
      <p className="text-slate-800">{t("text")}</p>
      <Link href={findHref({ ...HYDERABAD_CENTRE, type: OVER_8_TYPES[0], radius_km: SEO_RADIUS_KM })} className={linkClass}>
        {t("find")}
      </Link>
      <div>
        <Link href="/find" className={linkClass}>
          {tf("openDirectory")}
        </Link>
      </div>
    </section>
  );
}
