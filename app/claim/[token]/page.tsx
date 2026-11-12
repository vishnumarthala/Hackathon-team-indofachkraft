import type { Metadata } from "next";
import Link from "next/link";
import { ClaimButton } from "@/components/providers/ClaimButton";
import { getAuthenticatedUser } from "@/lib/auth";
import { getT } from "@/lib/i18n/server";
import { previewClaim } from "@/lib/providers/claims";
import { ClaimTokenSchema } from "@/lib/providers/schemas";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT("providers.claim");
  return { title: t("metaTitle"), robots: { index: false, follow: false }, referrer: "no-referrer" };
}

// FR-6 public claim page. Invalid, expired, used and superseded links all show the same message.
export default async function ClaimPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const t = await getT("providers");
  const preview = ClaimTokenSchema.safeParse(token).success ? await previewClaim(token) : null;

  if (!preview) {
    return (
      <div className="mx-auto max-w-lg space-y-3 px-4 py-10">
        <h1 className="text-2xl font-semibold text-slate-900">{t("claim.invalid")}</h1>
        <p className="text-slate-700">{t("claim.invalidHint")}</p>
      </div>
    );
  }

  const user = await getAuthenticatedUser();
  const path = `/claim/${token}`;
  return (
    <div className="mx-auto max-w-lg space-y-4 px-4 py-10">
      <h1 className="text-2xl font-semibold text-slate-900">{t("claim.title")}</h1>
      <p className="text-slate-700">
        {t("claim.intro", {
          name: preview.display_name,
          type: t(`types.${preview.provider_type as "pediatrician"}`),
        })}
      </p>
      {user ? (
        <>
          <p className="text-sm text-slate-700">{t("claim.signedInAs", { email: user.email ?? "" })}</p>
          <ClaimButton token={token} />
        </>
      ) : (
        <>
          <p className="text-slate-700">{t("claim.signInFirst")}</p>
          <div className="flex flex-wrap gap-4">
            <Link href={`/login?next=${encodeURIComponent(path)}`} className="font-medium text-slate-900 underline">
              {t("claim.signIn")}
            </Link>
            <Link href={`/join?next=${encodeURIComponent(path)}`} className="font-medium text-slate-900 underline">
              {t("claim.createAccount")}
            </Link>
          </div>
        </>
      )}
    </div>
  );
}
