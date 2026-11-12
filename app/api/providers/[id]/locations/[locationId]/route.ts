import { requireProviderProfileOwner } from "@/lib/authz";
import { isUuid } from "@/lib/cases/validation";
import { fail, ok } from "@/lib/http";
import { unlinkLocation } from "@/lib/providers";
import { invalidatePublicProviders } from "@/lib/providers/public";

export const dynamic = "force-dynamic";

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string; locationId: string }> }) {
  const { id, locationId } = await params;
  const gate = await requireProviderProfileOwner(id);
  if ("response" in gate) return gate.response;
  if (!isUuid(locationId) || !(await unlinkLocation(id, locationId))) return fail(404, "Location not found");
  invalidatePublicProviders();
  return ok({ removed: true });
}
