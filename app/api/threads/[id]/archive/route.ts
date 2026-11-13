import { fail, ok } from "@/lib/http";
import { requireThreadAccess } from "@/lib/messaging/access";
import { archiveThread } from "@/lib/messaging/store";

export const dynamic = "force-dynamic";

// 027 FR-6: owners/admins of the case's organisation archive a thread (read-only afterwards). Others with
// access -> 403; no access -> 404.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireThreadAccess(id);
  if (gate instanceof Response) return gate;
  const result = await archiveThread(gate.thread.id, gate.user.id);
  if (!result.ok) return fail(result.status, result.error);
  return ok(result.data);
}
