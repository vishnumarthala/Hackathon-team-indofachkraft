import { requirePlatformAdminApi } from "@/lib/authz";
import { isUuid } from "@/lib/cases/validation";
import { fail, ok } from "@/lib/http";
import { retryDead } from "@/lib/notify/inbox";

export const dynamic = "force-dynamic";

// FR-9: platform admin resets a dead notification to pending (audited in the same transaction).
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const result = await requirePlatformAdminApi();
  if ("response" in result) return result.response;
  const { id } = await params;
  if (!isUuid(id)) return fail(404, "Notification not found");
  if (!(await retryDead(id, result.actor.user.id))) return fail(404, "Notification not found");
  return ok({ id, status: "pending" });
}
