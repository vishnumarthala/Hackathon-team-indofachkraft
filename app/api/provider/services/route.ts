import { audit } from "@/lib/audit";
import { requireProviderContext } from "@/lib/booking/authz";
import { withProviderInput } from "@/lib/booking/provider-routes";
import { ServiceCreateSchema } from "@/lib/booking/schemas";
import { createService, listServices } from "@/lib/booking/store";
import { ok, parseJson } from "@/lib/http";
import { invalidatePublicProviders } from "@/lib/providers/public";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// FR-8 services of the caller's own profile. In-clinic services use one of the profile's locations (its org);
// video services use the requested org (an active membership) or the provider's first org.
export async function GET() {
  const gate = await requireProviderContext();
  if ("response" in gate) return gate.response;
  return ok({ services: await listServices(gate.ctx.profile.id) });
}

export async function POST(req: Request) {
  const gate = await requireProviderContext();
  if ("response" in gate) return gate.response;
  const parsed = await parseJson(req, ServiceCreateSchema);
  if ("response" in parsed) return parsed.response;
  const result = await withProviderInput(() => createService(gate.ctx, parsed.data));
  if ("response" in result) return result.response;
  invalidatePublicProviders(); // consultation modes are derived from active services
  await audit({ actorUserId: gate.actor.user.id, action: "booking.service_created", entity: "service", entityId: result.data.id, orgId: result.data.org_id });
  return ok({ service: result.data }, 201);
}
