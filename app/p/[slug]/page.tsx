import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DemoBadge, jsonLdScript, ProviderAvatar, VerifiedBadge } from "@/components/providers/PublicProfile";
import { env } from "@/lib/env";
import { directionsUrl, staticMapUrl } from "@/lib/geo/constants";
import { getFormatter, getT } from "@/lib/i18n/server";
import { PRESCRIBER_TYPES } from "@/lib/providers/constants";
import { getPublicProfile } from "@/lib/providers/public";

// Public provider profile (ticket 028 FR-7). Only verified + listed profiles exist here; everything else
// (unverified, pending, rejected, suspended, unlisted, demo profiles when SHOW_SYNTHETIC_LISTINGS=false) 404s.
// Data is cached per slug and invalidated on every profile change (NFR-2); the translated chrome is
// rendered per request.

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const data = await getPublicProfile(slug);
  if (!data) return { title: "DoctorNearMe", robots: { index: false } };
  const t = await getT("providers");
  const name = data.provider.display_name;
  const type = t(`types.${data.provider.provider_type}`);
  const locality = data.locations[0]?.locality;
  return {
    title: { absolute: locality ? t("public.metaTitle", { name, type, locality }) : t("public.metaTitleNoLocality", { name, type }) },
    description: t("public.metaDescription", { name, type, locality: locality ?? "Hyderabad" }),
    robots: data.provider.is_synthetic ? { index: false } : undefined,
  };
}

export default async function PublicProfilePage({ params }: Props) {
  const { slug } = await params;
  const data = await getPublicProfile(slug);
  if (!data) notFound();
  const { provider, locations } = data;
  const t = await getT("providers");
  const td = await getT("directory");
  const format = await getFormatter();
  const browserKey = env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY;
  const mapped = locations.filter((loc) => loc.lat !== null && loc.lng !== null).map((loc) => ({ lat: Number(loc.lat), lng: Number(loc.lng) }));
  const modes = [provider.offers_in_clinic ? td("modes.in_clinic") : null, provider.offers_video ? td("modes.video") : null].filter(Boolean);
  const appUrl = env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "");

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": PRESCRIBER_TYPES.includes(provider.provider_type) ? "Physician" : "MedicalBusiness",
    name: provider.display_name,
    url: `${appUrl}/p/${provider.slug}`,
    ...(provider.photo_url ? { image: provider.photo_url } : {}),
    ...(locations.length
      ? {
          address: locations.map((loc) => ({
            "@type": "PostalAddress",
            streetAddress: [loc.address_line1, loc.address_line2].filter(Boolean).join(", "),
            addressLocality: loc.locality,
            addressRegion: loc.state,
            postalCode: loc.pincode,
            addressCountry: "IN",
          })),
        }
      : {}),
  };

  return (
    <article className="mx-auto max-w-3xl space-y-6 px-4 py-8">
      {jsonLdScript(jsonLd)}
      {provider.is_synthetic ? (
        <p role="note" className="rounded bg-violet-50 px-3 py-2 text-sm text-violet-900">
          {t("public.demoNote")}
        </p>
      ) : null}
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <ProviderAvatar provider={provider} t={t} size={112} />
        <div className="space-y-2">
          <h1 className="flex flex-wrap items-center gap-2 text-2xl font-semibold text-slate-900">
            {provider.display_name}
            {provider.is_synthetic ? <DemoBadge t={t} /> : null}
          </h1>
          <p className="text-slate-700">{t(`types.${provider.provider_type}`)}</p>
          <VerifiedBadge provider={provider} t={t} format={format} />
        </div>
      </header>

      <dl className="grid gap-4 sm:grid-cols-2">
        {provider.qualifications ? (
          <div>
            <dt className="text-sm font-semibold text-slate-900">{t("public.qualifications")}</dt>
            <dd className="text-slate-700">{provider.qualifications}</dd>
          </div>
        ) : null}
        {provider.years_experience !== null ? (
          <div>
            <dt className="sr-only">{t("editor.experience")}</dt>
            <dd className="text-slate-700">{t("public.experience", { count: provider.years_experience })}</dd>
          </div>
        ) : null}
        {provider.languages.length ? (
          <div>
            <dt className="text-sm font-semibold text-slate-900">{t("public.languages")}</dt>
            <dd className="text-slate-700">
              {provider.languages.map((l) => t(`languages.${l as "en"}`)).join(", ")}
            </dd>
          </div>
        ) : null}
      </dl>

      {provider.bio ? (
        <section>
          <h2 className="text-lg font-semibold text-slate-900">{t("public.about")}</h2>
          <p className="whitespace-pre-line text-slate-700">{provider.bio}</p>
        </section>
      ) : null}

      {locations.length ? (
        <section>
          <h2 className="text-lg font-semibold text-slate-900">{t("public.locations")}</h2>
          {/* 029 FR-6: static map when a browser key is configured; directions links work without one. */}
          {browserKey && mapped.length ? (
            // eslint-disable-next-line @next/next/no-img-element -- Google Maps Static API image
            <img
              src={staticMapUrl(mapped, browserKey)}
              alt={td("profileMap.alt", { name: provider.display_name })}
              width={640}
              height={320}
              loading="lazy"
              className="mt-2 h-auto w-full rounded border border-slate-200"
            />
          ) : null}
          <ul className="mt-2 space-y-3">
            {locations.map((loc) => (
              <li key={loc.id} className="rounded border border-slate-200 bg-white p-3 text-sm text-slate-700">
                <p className="font-medium text-slate-900">
                  {loc.org.listed ? (
                    <Link href={`/c/${loc.org.slug}`} className="underline">
                      {loc.org.name}
                    </Link>
                  ) : (
                    loc.org.name
                  )}
                  {loc.name !== loc.org.name ? ` - ${loc.name}` : ""}
                </p>
                <address className="not-italic">
                  {[loc.address_line1, loc.address_line2, loc.locality, `${loc.city} ${loc.pincode}`].filter(Boolean).join(", ")}
                </address>
                {loc.org.phone_public ? (
                  <p>
                    {t("public.phone")}: <a href={`tel:${loc.org.phone_public.replace(/[\s-]/g, "")}`} className="underline">{loc.org.phone_public}</a>
                  </p>
                ) : null}
                {loc.org.website ? (
                  <p>
                    {t("public.website")}: <a href={loc.org.website} rel="noopener noreferrer nofollow" target="_blank" className="underline">{loc.org.website}</a>
                  </p>
                ) : null}
                {loc.lat !== null && loc.lng !== null ? (
                  <a
                    href={directionsUrl(Number(loc.lat), Number(loc.lng))}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={td("profileMap.directionsTo", { place: loc.name })}
                    className="mt-1 inline-flex min-h-11 items-center font-medium text-teal-800 underline"
                  >
                    {td("profileMap.directions")}
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section>
        <h2 className="text-lg font-semibold text-slate-900">{t("public.consultModes")}</h2>
        <p className="text-slate-700">{modes.length ? modes.join(", ") : t("public.consultModesSoon")}</p>
      </section>

      <div className="space-y-1">
        <button type="button" disabled aria-describedby="book-soon" className="min-h-11 rounded bg-slate-900 px-6 py-2 font-medium text-white opacity-50">
          {t("public.book")}
        </button>
        <p id="book-soon" className="text-sm text-slate-600">
          {t("public.bookSoon")}
        </p>
      </div>
    </article>
  );
}
