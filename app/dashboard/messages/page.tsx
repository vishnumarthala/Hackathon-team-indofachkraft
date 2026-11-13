import { EmergencyBanner } from "@/components/messaging/EmergencyBanner";
import { LiveThreadsRefresher } from "@/components/messaging/LiveThreadsRefresher";
import { ThreadList } from "@/components/messaging/ThreadList";
import { requireProviderPage } from "@/lib/authz";
import { getT } from "@/lib/i18n/server";
import { listThreads } from "@/lib/messaging/store";

export const dynamic = "force-dynamic";

// 027 FR-4: the provider's inbox - conversations of every case they can access (022 rule), newest first.
export default async function DashboardMessagesPage() {
  const { user } = await requireProviderPage();
  const [threads, t] = await Promise.all([listThreads(user.id), getT("messaging")]);
  return (
    <div className="mx-auto max-w-5xl space-y-4 px-4 py-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-sm text-slate-700">{t("providerIntro")}</p>
      </header>
      <EmergencyBanner />
      <LiveThreadsRefresher endpoint="/api/threads" />
      <ThreadList threads={threads} hrefBase="/dashboard/messages" show="child" label={t("threadsLabel")} />
    </div>
  );
}
