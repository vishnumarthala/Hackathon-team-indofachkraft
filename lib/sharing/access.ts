// Ticket 022 FR-2: which sharing grants currently give a provider read access to a child's records. Server only.
// The rule lives in SQL (`active_sharing_grants`): unrevoked, unexpired, the granting guardian still linked,
// and the provider can access a case of the child in the grantee organisation (owner/admin or assigned).
import { isUuid } from "@/lib/cases/validation";
import { supabaseAdmin } from "@/lib/db";
import type { ShareScope } from "@/lib/sharing/scopes";

export type ActiveGrant = { grant_id: string; source_org_id: string; grantee_org_id: string; expires_at: string | null };

export async function getActiveGrants(
  userId: string,
  childId: string,
  scope: ShareScope,
  granteeOrgId?: string,
): Promise<ActiveGrant[]> {
  if (!isUuid(childId) || (granteeOrgId !== undefined && !isUuid(granteeOrgId))) return [];
  const { data, error } = await supabaseAdmin().rpc("active_sharing_grants", {
    p_user: userId,
    p_child: childId,
    p_scope: scope,
    p_grantee: granteeOrgId ?? null,
  });
  if (error) throw new Error(`Could not check sharing grants: ${error.message}`);
  return (data ?? []) as ActiveGrant[];
}

export function sourceOrgIdsOf(grants: ActiveGrant[]): string[] {
  return [...new Set(grants.map((g) => g.source_org_id))];
}
