import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { jsonLdScript, ProviderCard } from "@/components/providers/PublicProfile";
import { env } from "@/lib/env";
import { getFormatter, getT } from "@/lib/i18n/server";
import { getPublicCentre } from "@/lib/providers/public";

// Public centre page (ticket 028 FR-7): a listed organisation with its verified, listed providers.
// 404 when the organisation is not listed or lists no visible provider.

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const data = await getPublicCentre(slug);
  if (!data) return { title: "DoctorNearMe", robots: { index: false } };
  const t = await getT("providers.public");
  const locality = data.locations[0]?.locality;
  return {
    title: {
      absolute: locality
        ? t("centreMetaTitle", { name: data.org.name, locality })
        : t("centreMetaTitleNoLocality", { name: data.org.name }),
    },
  };
}

export default async function CentrePage({ params }: Props) {
  const { slug } = await params;
  const data = await getPublicCentre(slug);
  if (!data) notFound();
  const { org, providers, locations } = data;
  const t = await getT("providers");
  const format = await getFormatter();
  const appUrl = env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "");

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "MedicalBusiness",
    name: org.name,
    url: `${appUrl}/c/${org.slug}`,
    ...(org.phone_public ? { telephone: org.phone_public } : {}),
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
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold text-slate-900">{org.name}</h1>
        <p className="text-slate-700">{org.kind === "centre" ? t("public.centre") : t("public.solo")}</p>
      </header>
      {org.about ? <p className="whitespace-pre-line text-slate-700">{org.about}</p> : null}
      {org.phone_public || org.website ? (
        <p className="space-x-4 text-sm text-slate-700">
          {org.phone_public ? (
            <span>
              {t("public.phone")}: <a href={`tel:${org.phone_public.replace(/[\s-]/g, "")}`} className="underline">{org.phone_public}</a>
            </span>
          ) : null}
          {org.website ? (
            <span>
              {t("public.website")}: <a href={org.website} rel="noopener noreferrer nofollow" target="_blank" className="underline">{org.website}</a>
            </span>
          ) : null}
        </p>
      ) : null}

      {locations.length ? (
        <section>
          <h2 className="text-lg font-semibold text-slate-900">{t("public.locations")}</h2>
          <ul className="mt-2 space-y-2 text-sm text-slate-700">
            {locations.map((loc) => (
              <li key={loc.id}>
                <span className="font-medium text-slate-900">{loc.name}</span>
                <address className="not-italic">
                  {[loc.address_line1, loc.address_line2, loc.locality, `${loc.city} ${loc.pincode}`].filter(Boolean).join(", ")}
                </address>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section>
        <h2 className="text-lg font-semibold text-slate-900">{t("public.providers")}</h2>
        <ul className="mt-2 space-y-3">
          {providers.map((p) => (
            <ProviderCard key={p.id} provider={p} t={t} format={format} />
          ))}
        </ul>
      </section>
    </article>
  );
}
