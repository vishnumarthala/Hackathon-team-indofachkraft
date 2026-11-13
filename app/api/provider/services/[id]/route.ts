import { audit } from "@/lib/audit";
import { requireProviderContext } from "@/lib/booking/authz";
import { withProviderInput } from "@/lib/booking/provider-routes";
import { ServiceUpdateSchema } from "@/lib/booking/schemas";
import { updateService } from "@/lib/booking/store";
import { isUuid } from "@/lib/cases/validation";
import { fail, ok, parseJson } from "@/lib/http";
import { invalidatePublicProviders } from "@/lib/providers/public";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// FR-8 edit / deactivate (`active: false`) one of the caller's services. Existing appointments keep their snapshot.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireProviderContext();
  if ("response" in gate) return gate.response;
  if (!isUuid(id)) return fail(404, "Service not found");
  const parsed = await parseJson(req, ServiceUpdateSchema);
  if ("response" in parsed) return parsed.response;
  const result = await withProviderInput(() => updateService(gate.ctx, id, parsed.data));
  if ("response" in result) return result.response;
  if (!result.data) return fail(404, "Service not found");
  invalidatePublicProviders();
  await audit({ actorUserId: gate.actor.user.id, action: "booking.service_updated", entity: "service", entityId: id, details: { fields: Object.keys(parsed.data) } });
  return ok({ service: result.data });
}
