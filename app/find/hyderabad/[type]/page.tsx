import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ResultList } from "@/components/directory/ResultList";
import { env } from "@/lib/env";
import { DIRECTORY_TYPES, findHref, HYDERABAD_CENTRE, SEO_RADIUS_KM, typeFromSlug, typeSlug } from "@/lib/geo/constants";
import { searchProviders } from "@/lib/geo/search";
import { getT } from "@/lib/i18n/server";

// FR-7 SEO landing pages: server-rendered, indexable list of verified + listed providers of one type within
// 25 km of central Hyderabad, nearest first. Linked from the landing page footer and from /find. Rendered per
// request (the root layout reads the locale cookie); unknown type slugs 404.

type Props = { params: Promise<{ type: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const type = typeFromSlug((await params).type);
  if (!type) return { title: "DoctorNearMe", robots: { index: false } };
  const t = await getT("directory");
  const plural = t(`typesPlural.${type}`);
  return {
    title: { absolute: t("seo.metaTitle", { type: plural }) },
    description: t("seo.metaDescription", { type: plural }),
    alternates: { canonical: `${env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "")}/find/hyderabad/${typeSlug(type)}` },
  };
}

export default async function HyderabadTypePage({ params }: Props) {
  const type = typeFromSlug((await params).type);
  if (!type) notFound();
  const t = await getT("directory");
  const tp = await getT("providers");
  const data = await searchProviders({
    lat: HYDERABAD_CENTRE.lat,
    lng: HYDERABAD_CENTRE.lng,
    radiusKm: SEO_RADIUS_KM,
    type,
    mode: "any",
    page: 1,
    pageSize: 50,
  });
  const plural = t(`typesPlural.${type}`);

  return (
    <div className="mx-auto max-w-4xl space-y-6 px-4 py-8">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold text-slate-900">{t("seo.title", { type: plural })}</h1>
        <p className="text-slate-700">{t("seo.intro", { km: SEO_RADIUS_KM })}</p>
        <Link href={findHref({ type })} className="inline-flex min-h-11 items-center font-medium text-slate-900 underline">
          {t("seo.searchNearYou")}
        </Link>
      </header>
      {data.results.length ? (
        <ResultList results={data.results} t={t} tp={tp} />
      ) : (
        <p role="status" className="rounded border border-slate-200 bg-slate-50 p-4 text-slate-800">
          {t("seo.empty")}
        </p>
      )}
      <nav aria-labelledby="seo-browse" className="space-y-2 border-t border-slate-200 pt-6">
        <h2 id="seo-browse" className="text-base font-semibold text-slate-900">
          {t("browse.title")}
        </h2>
        <ul className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
          {DIRECTORY_TYPES.filter((other) => other !== type).map((other) => (
            <li key={other}>
              <Link href={`/find/hyderabad/${typeSlug(other)}`} className="inline-flex min-h-11 items-center text-slate-800 underline">
                {t(`typesPlural.${other}`)}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}
