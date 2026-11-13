import { auditActorOf } from "@/lib/audit";
import { requireProviderApi } from "@/lib/authz";
import { isUuid } from "@/lib/cases/validation";
import { createPackage, feesRouteError, listPackages, PackageInputSchema } from "@/lib/fees/store";
import { fail, ok, parseJson } from "@/lib/http";
import { canManage, getMembershipRole } from "@/lib/orgs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function gate(id: string) {
  const g = await requireProviderApi();
  if ("response" in g) return g;
  if (!isUuid(id)) return { response: fail(404, "Organisation not found") };
  const role = await getMembershipRole(g.actor.user.id, id);
  if (!role) return { response: fail(404, "Organisation not found") };
  return { actor: g.actor, role };
}

// 045 FR-7 org settings `Packages`: members read the catalogue; owner/admin add packages (members 403, other
// organisations 404). { name, session_count 1-60, price_inr, validity_days 7-180, service_ids (this org's), active }.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const g = await gate(id);
  if ("response" in g) return g.response;
  return ok({ packages: await listPackages(id) });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const g = await gate(id);
  if ("response" in g) return g.response;
  if (!canManage(g.role)) return fail(403, "Only organisation owners and admins can change packages");
  const parsed = await parseJson(req, PackageInputSchema);
  if ("response" in parsed) return parsed.response;
  try {
    const pkg = await createPackage(id, parsed.data, { ...auditActorOf(g.actor.user, g.actor.role), actorUserId: g.actor.user.id });
    return ok({ package: pkg }, 201);
  } catch (err) {
    const res = await feesRouteError(err);
    if (res) return res;
    throw err;
  }
}
