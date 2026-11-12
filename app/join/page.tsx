import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { JoinForm } from "@/components/providers/JoinForm";
import { getAuthenticatedUser } from "@/lib/auth";
import { isGoogleAuthEnabled } from "@/lib/family/auth-settings";
import { getT } from "@/lib/i18n/server";
import { getProfileByUserId } from "@/lib/providers";
import { PROVIDER_TYPES, type ProviderType } from "@/lib/providers/constants";

const isProviderType = (v: unknown): v is ProviderType => (PROVIDER_TYPES as readonly unknown[]).includes(v);

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT("providers.join");
  return { title: t("metaTitle") };
}

const CLAIM_PATH = /^\/claim\/[A-Za-z0-9_-]{43}$/;

// FR-2 self-registration (public). Signed-out visitors create an account; signed-in users create their
// provider profile. `?next=/claim/<token>` is the claim flow: account only, then back to the link.
export default async function JoinPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  const claimPath = next && CLAIM_PATH.test(next) ? next : null;
  const user = await getAuthenticatedUser();
  if (user && claimPath) redirect(claimPath);
  if (user && (await getProfileByUserId(user.id))) redirect("/dashboard/profile");

  const t = await getT("providers.join");
  const meta = (user?.user_metadata ?? {}) as Record<string, unknown>;
  return (
    <div className="mx-auto w-full max-w-md px-4 py-10">
      <h1 className="text-2xl font-semibold text-slate-900">{t("title")}</h1>
      <p className="mb-6 mt-2 text-slate-700">{t("intro")}</p>
      <JoinForm
        signedInEmail={user?.email ?? null}
        googleEnabled={user ? false : await isGoogleAuthEnabled()}
        claimPath={claimPath}
        defaultName={typeof meta.full_name === "string" ? meta.full_name.slice(0, 120) : ""}
        defaultType={isProviderType(meta.provider_type) ? meta.provider_type : null}
      />
    </div>
  );
}
