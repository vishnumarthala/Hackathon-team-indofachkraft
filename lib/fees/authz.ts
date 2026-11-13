// Ticket 045: gates for the fee routes and pages. The server uses the service-role client, so every route calls one of
// these first. Staff: 022's case rule (owner/admin of the case's organisation = `manage`; an assigned member may look
// but not change money: 403). Other organisations' ids -> 404. Guardians: an active link to the child.
import { notFound } from "next/navigation";
import { requireProviderApi, requireProviderPage, getCaseAccessLevel, type Actor, type CaseAccessLevel } from "@/lib/authz";
import { isUuid } from "@/lib/cases/validation";
import { fail } from "@/lib/http";
import { pg } from "@/lib/pg";

export type FeesScope = { caseId: string; orgId: string; childId: string; orgName: string; access: CaseAccessLevel };

async function caseScope(caseId: string, access: CaseAccessLevel): Promise<FeesScope | null> {
  const sql = await pg();
  const [row] = await sql<{ org_id: string; child_id: string | null; org_name: string }[]>`
    select c.org_id, c.child_id, o.name as org_name
    from public.cases c join public.organizations o on o.id = c.org_id where c.id = ${caseId}`;
  if (!row?.child_id) return null;
  return { caseId, orgId: row.org_id, childId: row.child_id, orgName: row.org_name, access };
}

/** API gate. `manage` = owner/admin only (members 403). Unknown / other-org case, or a case without a child -> 404. */
export async function requireFeesCaseApi(
  caseId: string,
  opts: { manage?: boolean } = {},
): Promise<{ actor: Actor; scope: FeesScope } | { response: Response }> {
  const g = await requireProviderApi();
  if ("response" in g) return g;
  if (!isUuid(caseId)) return { response: fail(404, "Case not found") };
  const access = await getCaseAccessLevel(g.actor.user.id, caseId);
  if (!access) return { response: fail(404, "Case not found") };
  const scope = await caseScope(caseId, access);
  if (!scope) return { response: fail(404, "Case not found") };
  if (opts.manage && access !== "manage") return { response: fail(403, "Only organisation owners and admins can change fees") };
  return { actor: g.actor, scope };
}

/** Page gate (layouts are not a gate): 404 for anyone without case access. */
export async function requireFeesCasePage(caseId: string): Promise<{ actor: Actor; scope: FeesScope | null; access: CaseAccessLevel }> {
  const actor = await requireProviderPage();
  const access = await getCaseAccessLevel(actor.user.id, caseId);
  if (!access) notFound();
  return { actor, scope: await caseScope(caseId, access), access };
}

/** Staff may see a payment (QR, receipt) when they are an active member of its organisation with access to one of the
 * child's cases there (022). */
export async function staffCanSeeAccount(userId: string, orgId: string, childId: string): Promise<boolean> {
  const sql = await pg();
  const [row] = await sql<{ ok: boolean }[]>`
    select exists (
      select 1 from public.cases c
      where c.org_id = ${orgId} and c.child_id = ${childId} and public.case_access_level(${userId}, c.id) is not null
    ) as ok`;
  return Boolean(row?.ok);
}

/** Guardians: an active link to the child (020). */
export async function guardianOfChild(userId: string, childId: string): Promise<boolean> {
  const sql = await pg();
  const [row] = await sql<{ ok: boolean }[]>`
    select exists (
      select 1 from public.guardian_links gl join public.children c on c.id = gl.child_id
      where gl.child_id = ${childId} and gl.user_id = ${userId} and gl.status = 'active' and c.deleted_at is null
    ) as ok`;
  return Boolean(row?.ok);
}
