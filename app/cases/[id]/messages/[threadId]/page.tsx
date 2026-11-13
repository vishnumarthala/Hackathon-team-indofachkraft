import { notFound } from "next/navigation";
import { ThreadPage } from "@/components/messaging/ThreadPage";
import { requireCasePage } from "@/lib/authz";
import { requireThreadPage } from "@/lib/messaging/access";

export const dynamic = "force-dynamic";

// 027 FR-4: one conversation inside the case workspace; the thread must belong to this case.
export default async function CaseThreadPage({ params }: { params: Promise<{ id: string; threadId: string }> }) {
  const { id, threadId } = await params;
  await requireCasePage(id);
  const { user, level, thread } = await requireThreadPage(threadId, "provider");
  if (thread.case_id !== id) notFound();
  return <ThreadPage thread={thread} level={level} viewerId={user.id} backHref={`/cases/${id}/messages`} />;
}
