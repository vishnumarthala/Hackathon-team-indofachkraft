import type { Metadata } from "next";
import { NotificationList } from "@/components/notifications/NotificationList";
import { requireGuardianPage } from "@/lib/authz";
import { getT } from "@/lib/i18n/server";
import { listInbox } from "@/lib/notify/inbox";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT("notifications");
  return { title: t("title") };
}

// FR-7: the guardian's own in-app notifications.
export default async function FamilyNotificationsPage() {
  const { user } = await requireGuardianPage();
  const t = await getT("notifications");
  const inbox = await listInbox(user.id, null);
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-slate-900 sm:text-3xl">{t("title")}</h1>
      <NotificationList initialItems={inbox.items} initialCursor={inbox.next_cursor} initialUnread={inbox.unread} />
    </div>
  );
}
