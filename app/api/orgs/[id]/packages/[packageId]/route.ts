import { auditActorOf } from "@/lib/audit";
import { requireProviderApi } from "@/lib/authz";
import { isUuid } from "@/lib/cases/validation";
import { feesRouteError, PackageUpdateSchema, updatePackage } from "@/lib/fees/store";
import { fail, ok, parseJson } from "@/lib/http";
import { canManage, getMembershipRole } from "@/lib/orgs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 045 FR-7: edit or retire (`active: false`) a package. Owner/admin only; offers already made keep their snapshot.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string; packageId: string }> }) {
  const { id, packageId } = await params;
  const g = await requireProviderApi();
  if ("response" in g) return g.response;
  if (!isUuid(id) || !isUuid(packageId)) return fail(404, "Package not found");
  const role = await getMembershipRole(g.actor.user.id, id);
  if (!role) return fail(404, "Package not found");
  if (!canManage(role)) return fail(403, "Only organisation owners and admins can change packages");
  const parsed = await parseJson(req, PackageUpdateSchema);
  if ("response" in parsed) return parsed.response;
  try {
    const pkg = await updatePackage(id, packageId, parsed.data, { ...auditActorOf(g.actor.user, g.actor.role), actorUserId: g.actor.user.id });
    return ok({ package: pkg });
  } catch (err) {
    const res = await feesRouteError(err);
    if (res) return res;
    throw err;
  }
}
