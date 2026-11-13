import type { Metadata } from "next";
import Link from "next/link";
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
  const ti = await getT("integrations");
  const tp = await getT("fees.settings");
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
      {/* 045 FR-7: the organisation's session packages. */}
      <section aria-labelledby="packages-heading" className="space-y-2">
        <h2 id="packages-heading" className="text-lg font-semibold text-slate-900">
          {tp("link")}
        </h2>
        <div className="space-y-2 rounded-xl border border-slate-200 bg-white p-4">
          <p className="text-sm text-slate-700">{tp("linkIntro")}</p>
          <Link href="/dashboard/settings/packages" className="inline-flex min-h-11 items-center font-semibold text-teal-800 underline">
            {tp("title")}
          </Link>
        </div>
      </section>
      {/* 037: Google Calendar / Meet connection. */}
      <section aria-labelledby="integrations-heading" className="space-y-2">
        <h2 id="integrations-heading" className="text-lg font-semibold text-slate-900">
          {ti("title")}
        </h2>
        <div className="space-y-2 rounded-xl border border-slate-200 bg-white p-4">
          <p className="text-sm text-slate-700">{ti("settingsIntro")}</p>
          <Link href="/dashboard/settings/integrations" className="inline-flex min-h-11 items-center font-semibold text-teal-800 underline">
            {ti("settingsLink")}
          </Link>
        </div>
      </section>
    </div>
  );
}
