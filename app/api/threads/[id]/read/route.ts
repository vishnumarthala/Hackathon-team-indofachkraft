import { fail, ok } from "@/lib/http";
import { requireThreadAccess } from "@/lib/messaging/access";
import { markThreadRead } from "@/lib/messaging/store";

export const dynamic = "force-dynamic";

// 027 FR-2: the caller has read the thread up to now (suppresses the delayed notification, FR-3).
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireThreadAccess(id);
  if (gate instanceof Response) return gate;
  const result = await markThreadRead(gate.thread.id, gate.user.id);
  if (!result.ok) return fail(result.status, result.error);
  return ok(result.data);
}
