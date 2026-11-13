import { ThreadPage } from "@/components/messaging/ThreadPage";
import { requireGuardianPage } from "@/lib/authz";
import { requireThreadPage } from "@/lib/messaging/access";

export const dynamic = "force-dynamic";

// 027 FR-4: one conversation, for a guardian of the thread's child (others: 404).
export default async function FamilyThreadPage({ params }: { params: Promise<{ threadId: string }> }) {
  await requireGuardianPage();
  const { threadId } = await params;
  const { user, level, thread } = await requireThreadPage(threadId, "family");
  return <ThreadPage thread={thread} level={level} viewerId={user.id} backHref="/family/messages" />;
}
