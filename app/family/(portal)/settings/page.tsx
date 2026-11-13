import { ProfileNameForm } from "@/components/family/ProfileNameForm";
import { SignInMethods } from "@/components/family/SignInMethods";
import { NotificationPreferencesForm } from "@/components/notifications/NotificationPreferencesForm";
import { requireGuardianPage } from "@/lib/authz";
import { env } from "@/lib/env";
import { isGoogleAuthEnabled } from "@/lib/family/auth-settings";
import { canUnlink, signInMethods } from "@/lib/family/identities";
import { maskPhone } from "@/lib/family/phone";
import { getT } from "@/lib/i18n/server";
import { getPreferences } from "@/lib/notify/inbox";

export const dynamic = "force-dynamic";

const NOTICES = { google_in_use: "googleInUse", link_failed: "linkFailed" } as const;

// FR-8/FR-9: the guardian's own name and sign-in methods. Phone numbers are shown masked only.
export default async function FamilySettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; linked?: string }>;
}) {
  const { user, profile } = await requireGuardianPage();
  const { error, linked } = await searchParams;
  const t = await getT("family.settings");
  const tn = await getT("notifications.prefs");
  const notificationPrefs = await getPreferences(user.id);
  const methods = signInMethods(user);
  const notice =
    error && error in NOTICES ? NOTICES[error as keyof typeof NOTICES] : linked === "google" ? ("linked" as const) : null;

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-bold text-slate-900 sm:text-3xl">{t("title")}</h1>
      <section aria-labelledby="profile-heading" className="space-y-4">
        <h2 id="profile-heading" className="text-lg font-semibold text-slate-900">
          {t("profile")}
        </h2>
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <ProfileNameForm initialName={profile.display_name ?? ""} />
        </div>
      </section>
      <section aria-labelledby="methods-heading" className="space-y-4">
        <h2 id="methods-heading" className="text-lg font-semibold text-slate-900">
          {t("methods")}
        </h2>
        <SignInMethods
          appUrl={env.NEXT_PUBLIC_APP_URL}
          googleEnabled={await isGoogleAuthEnabled()}
          initialNotice={notice}
          view={{
            googleConnected: methods.google !== null,
            googleEmail: methods.google?.email ?? null,
            phoneMasked: methods.phone ? maskPhone(methods.phone) : null,
            canUnlinkGoogle: canUnlink(methods, "google"),
            canUnlinkPhone: canUnlink(methods, "phone"),
          }}
        />
      </section>
      <section aria-labelledby="notifications-heading" className="space-y-4">
        <h2 id="notifications-heading" className="text-lg font-semibold text-slate-900">
          {tn("title")}
        </h2>
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <NotificationPreferencesForm initial={notificationPrefs} />
        </div>
      </section>
    </div>
  );
}
