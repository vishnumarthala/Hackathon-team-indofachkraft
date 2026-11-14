// Ticket 046: gates for the payout routes and pages. The server uses the service-role client, so every route calls one
// of these first. Centre payouts: owner/admin of the organisation (members 403, other organisations 404). Accepting the
// fee notice: the owner only (FR-8). Admin payouts: platform admins (requirePlatformAdminApi / Page in lib/authz.ts).
import { forbidden } from "next/navigation";
import { requireProviderApi, requireProviderPage, type Actor } from "@/lib/authz";
import { isUuid } from "@/lib/cases/validation";
import { fail } from "@/lib/http";
import { canManage, getMembershipRole, listMemberships, type Organization, type OrgRole } from "@/lib/orgs";

export async function requirePayoutsOrgApi(
  orgId: string,
  opts: { owner?: boolean } = {},
): Promise<{ actor: Actor; role: OrgRole } | { response: Response }> {
  const g = await requireProviderApi();
  if ("response" in g) return g;
  if (!isUuid(orgId)) return { response: fail(404, "Organisation not found") };
  const role = await getMembershipRole(g.actor.user.id, orgId);
  if (!role) return { response: fail(404, "Organisation not found") };
  if (!canManage(role)) return { response: fail(403, "Only organisation owners and admins can see payouts") };
  if (opts.owner && role !== "owner") {
    return { response: Response.json({ error: "Only the organisation owner can accept the platform fee.", code: "not_owner" }, { status: 403 }) };
  }
  return { actor: g.actor, role };
}

/** Page gate: the organisations the user manages (owner/admin); none -> 403 (members included). */
export async function requirePayoutsPage(requested?: string): Promise<{ actor: Actor; orgs: (Organization & { role: OrgRole })[]; org: Organization & { role: OrgRole } }> {
  const actor = await requireProviderPage();
  const orgs = (await listMemberships(actor.user.id)).filter((m) => canManage(m.org_role)).map((m) => ({ ...m.org, role: m.org_role }));
  if (!orgs.length) forbidden();
  const org = orgs.find((o) => o.id === requested) ?? orgs[0];
  return { actor, orgs, org };
}
