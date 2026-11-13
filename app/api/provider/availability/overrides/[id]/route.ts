import { audit } from "@/lib/audit";
import { requireProviderContext } from "@/lib/booking/authz";
import { deleteOverride } from "@/lib/booking/store";
import { isUuid } from "@/lib/cases/validation";
import { fail, ok } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// FR-8 remove a date override. Another provider's id -> 404.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireProviderContext();
  if ("response" in gate) return gate.response;
  if (!isUuid(id) || !(await deleteOverride(gate.ctx.profile.id, id))) return fail(404, "Override not found");
  await audit({ actorUserId: gate.actor.user.id, action: "booking.override_removed", entity: "availability_override", entityId: id });
  return ok({ removed: true });
}
