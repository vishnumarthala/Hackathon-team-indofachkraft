import type { Metadata } from "next";
import { NotificationPreferencesForm } from "@/components/notifications/NotificationPreferencesForm";
import { requireProviderPage } from "@/lib/authz";
import { getT } from "@/lib/i18n/server";
import { getPreferences } from "@/lib/notify/inbox";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT("notifications");
  return { title: t("settingsTitle") };
}

// FR-8: provider settings, `Notifications` section.
export default async function ProviderSettingsPage() {
  const { user } = await requireProviderPage();
  const t = await getT("notifications");
  const preferences = await getPreferences(user.id);
  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-6">
      <h1 className="text-2xl font-semibold text-slate-900">{t("settingsTitle")}</h1>
      <section aria-labelledby="notification-prefs-heading" className="space-y-4">
        <h2 id="notification-prefs-heading" className="text-lg font-semibold text-slate-900">
          {t("prefs.title")}
        </h2>
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <NotificationPreferencesForm initial={preferences} />
        </div>
      </section>
    </div>
  );
}
