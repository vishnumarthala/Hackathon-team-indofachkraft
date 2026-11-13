import { audit } from "@/lib/audit";
import { requireProviderContext } from "@/lib/booking/authz";
import { deleteRule } from "@/lib/booking/store";
import { isUuid } from "@/lib/cases/validation";
import { fail, ok } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// FR-8 remove weekly hours. Another provider's rule id -> 404. Booked appointments are not changed.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireProviderContext();
  if ("response" in gate) return gate.response;
  if (!isUuid(id) || !(await deleteRule(gate.ctx.profile.id, id))) return fail(404, "Hours not found");
  await audit({ actorUserId: gate.actor.user.id, action: "booking.hours_removed", entity: "availability_rule", entityId: id });
  return ok({ removed: true });
}
