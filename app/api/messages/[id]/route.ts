import { fail, ok } from "@/lib/http";
import { requireMessageAccess } from "@/lib/messaging/access";
import { deleteMessage } from "@/lib/messaging/store";

export const dynamic = "force-dynamic";

// 027 FR-2: delete your own message within 15 minutes; everyone then sees `This message was deleted.`
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireMessageAccess(id);
  if (gate instanceof Response) return gate;
  const result = await deleteMessage(gate.thread, gate.messageId, gate.user.id);
  if (!result.ok) return fail(result.status, result.error);
  return ok(result.data);
}
