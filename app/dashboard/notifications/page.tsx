import type { Metadata } from "next";
import { NotificationList } from "@/components/notifications/NotificationList";
import { requireProviderPage } from "@/lib/authz";
import { getT } from "@/lib/i18n/server";
import { listInbox } from "@/lib/notify/inbox";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT("notifications");
  return { title: t("title") };
}

// FR-7: the provider's own in-app notifications.
export default async function DashboardNotificationsPage() {
  const { user } = await requireProviderPage();
  const t = await getT("notifications");
  const inbox = await listInbox(user.id, null);
  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-6">
      <h1 className="text-2xl font-semibold text-slate-900">{t("title")}</h1>
      <NotificationList initialItems={inbox.items} initialCursor={inbox.next_cursor} initialUnread={inbox.unread} />
    </div>
  );
}
