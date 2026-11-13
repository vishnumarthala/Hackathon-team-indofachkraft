import { ThreadPage } from "@/components/messaging/ThreadPage";
import { requireThreadPage } from "@/lib/messaging/access";

export const dynamic = "force-dynamic";

// 027 FR-4: one conversation from the provider inbox (case access under 022's rule, else 404).
export default async function DashboardThreadPage({ params }: { params: Promise<{ threadId: string }> }) {
  const { threadId } = await params;
  const { user, level, thread } = await requireThreadPage(threadId, "provider");
  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <ThreadPage thread={thread} level={level} viewerId={user.id} backHref="/dashboard/messages" />
    </div>
  );
}
