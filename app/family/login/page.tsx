import Link from "next/link";
import { redirect } from "next/navigation";
import { FamilyLoginForm } from "@/components/family/FamilyLoginForm";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { getAuthenticatedUser, getUserRole } from "@/lib/auth";
import { homeForRole, safeRelativePath } from "@/lib/auth-access";
import { env } from "@/lib/env";
import { isGoogleAuthEnabled } from "@/lib/family/auth-settings";
import { getT } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

// FR-1 (public). Signed-in visitors go to their own home (FR-3); the proxy does the same.
export default async function FamilyLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const user = await getAuthenticatedUser();
  if (user) redirect(homeForRole(await getUserRole(user.id)));

  const { next, error } = await searchParams;
  const t = await getT("family.login");
  const nextPath = safeRelativePath(next) ?? "/family";
  return (
    <div className="mx-auto flex w-full max-w-md flex-col px-4 py-6 sm:py-10">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link href="/" className="flex min-h-11 items-center text-lg font-semibold text-slate-900">
          DoctorNearMe
        </Link>
        <LanguageSwitcher className="text-slate-700" />
      </div>
      <div className="mt-8 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-8">
        <h1 className="mb-6 text-2xl font-bold text-slate-900 break-words sm:text-3xl">{t("title")}</h1>
        <FamilyLoginForm
          appUrl={env.NEXT_PUBLIC_APP_URL}
          nextPath={nextPath}
          googleEnabled={await isGoogleAuthEnabled()}
          initialError={error === "oauth" ? "oauth" : null}
        />
        <p className="mt-6 text-sm text-slate-600">
          {t("privacy")}{" "}
          <Link href="/privacy" className="font-semibold text-teal-800 underline">
            {(await getT("privacy"))("link")}
          </Link>
        </p>
      </div>
      <p className="mt-6 text-center text-sm">
        <Link href="/login" className="inline-flex min-h-11 items-center font-semibold text-teal-800 underline-offset-4 hover:underline">
          {t("clinician")}
        </Link>
      </p>
    </div>
  );
}
