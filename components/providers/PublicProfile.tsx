import Link from "next/link";
import type { Formatter } from "@/lib/i18n/format";
import type { TFunction } from "@/lib/i18n/keys";
import type { PublicProvider } from "@/lib/providers/public";

// Server-rendered pieces of the public directory pages (ticket 028 FR-7). Only public fields are passed in.

export function DemoBadge({ t }: { t: TFunction<"providers"> }) {
  return <span className="rounded bg-violet-100 px-2 py-0.5 text-xs font-semibold text-violet-900">{t("demoBadge")}</span>;
}

export function VerifiedBadge({ provider, t, format }: { provider: PublicProvider; t: TFunction<"providers">; format: Formatter }) {
  const council = provider.council ? t(`councils.${provider.council}`) : null;
  return (
    <div className="space-y-0.5">
      <p className="inline-flex items-center gap-1 rounded bg-teal-100 px-2 py-1 text-sm font-semibold text-teal-900">
        <span aria-hidden="true">✓</span> {t("public.verifiedBadge")}
      </p>
      {provider.verified_at ? (
        <p className="text-xs text-slate-600">{t("public.verifiedOn", { date: format.date(provider.verified_at, "long") })}</p>
      ) : null}
      {council && provider.registration_masked ? (
        <p className="text-xs text-slate-600">
          {provider.council_state
            ? t("public.registrationState", { council, state: provider.council_state, number: provider.registration_masked })
            : t("public.registration", { council, number: provider.registration_masked })}
        </p>
      ) : null}
    </div>
  );
}

export function ProviderAvatar({ provider, t, size }: { provider: PublicProvider; t: TFunction<"providers">; size: number }) {
  if (provider.photo_url) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- public photo from Supabase storage
      <img
        src={provider.photo_url}
        alt={t("photo.alt", { name: provider.display_name })}
        width={size}
        height={size}
        className="shrink-0 rounded-full object-cover"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <div
      aria-hidden="true"
      className="flex shrink-0 items-center justify-center rounded-full bg-slate-200 font-semibold text-slate-600"
      style={{ width: size, height: size, fontSize: size / 3 }}
    >
      {provider.display_name.slice(0, 1).toUpperCase()}
    </div>
  );
}

export function ProviderCard({ provider, t, format }: { provider: PublicProvider; t: TFunction<"providers">; format: Formatter }) {
  return (
    <li className="flex gap-4 rounded border border-slate-200 bg-white p-4">
      <ProviderAvatar provider={provider} t={t} size={64} />
      <div className="min-w-0 space-y-1">
        <p className="flex flex-wrap items-center gap-2">
          <Link href={`/p/${provider.slug}`} className="text-lg font-semibold text-slate-900 underline-offset-4 hover:underline">
            {provider.display_name}
          </Link>
          {provider.is_synthetic ? <DemoBadge t={t} /> : null}
        </p>
        <p className="text-sm text-slate-700">{t(`types.${provider.provider_type}`)}</p>
        <VerifiedBadge provider={provider} t={t} format={format} />
        <Link href={`/p/${provider.slug}`} className="inline-flex min-h-11 items-center text-sm font-medium text-slate-900 underline">
          {t("public.viewProfile")}
        </Link>
      </div>
    </li>
  );
}

export function jsonLdScript(data: Record<string, unknown>) {
  return (
    <script
      type="application/ld+json"
      // Escape "<" so profile text can never close the script tag.
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, "\\u003c") }}
    />
  );
}
