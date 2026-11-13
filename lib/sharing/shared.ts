// Ticket 022 FR-6: the case workspace `Shared with us` tab. Server only. Every read re-checks the grants, so a
// revoked or expired grant (or a removed assignment) ends access on the next request (FR-7).
import { supabaseAdmin } from "@/lib/db";
import { getActiveGrants, sourceOrgIdsOf, type ActiveGrant } from "@/lib/sharing/access";
import { getShareLoader, type SharedItem, type SharedItemDetail } from "@/lib/sharing/registry";
import { SHARE_SCOPES, type ShareScope } from "@/lib/sharing/scopes";

export type CaseRef = { id: string; org_id: string; child_id: string };

export type SharedScopeView = { scope: ShareScope; available: boolean; items: SharedItem[] };
export type SharedSourceView = { sourceOrgId: string; sourceOrgName: string; expiresAt: string | null; scopes: SharedScopeView[] };

export async function orgNames(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const { data, error } = await supabaseAdmin().from("organizations").select("id, name, public_name").in("id", ids);
  if (error) throw new Error(`Could not load organisations: ${error.message}`);
  return new Map(
    ((data ?? []) as { id: string; name: string; public_name: string | null }[]).map((o) => [o.id, o.public_name ?? o.name]),
  );
}

/** Per source organisation: the granted scopes and, for scopes with a registered loader, the shared items. */
export async function listSharedForCase(userId: string, kase: CaseRef): Promise<SharedSourceView[]> {
  const perScope = await Promise.all(
    SHARE_SCOPES.map(async (scope) => ({ scope, grants: await getActiveGrants(userId, kase.child_id, scope, kase.org_id) })),
  );
  const sources = new Map<string, { expiresAt: string | null; scopes: SharedScopeView[] }>();
  for (const { scope, grants } of perScope) {
    if (grants.length === 0) continue;
    const loader = getShareLoader(scope);
    const items = loader ? await loader.list({ childId: kase.child_id, sourceOrgIds: sourceOrgIdsOf(grants) }) : [];
    for (const grant of grants) {
      const entry = sources.get(grant.source_org_id) ?? { expiresAt: grant.expires_at, scopes: [] };
      if (!entry.scopes.some((s) => s.scope === scope)) {
        entry.scopes.push({
          scope,
          available: loader !== null,
          items: items.filter((item) => item.sourceOrgId === grant.source_org_id),
        });
      }
      sources.set(grant.source_org_id, entry);
    }
  }
  const names = await orgNames([...sources.keys()]);
  return [...sources.entries()]
    .map(([sourceOrgId, entry]) => ({ sourceOrgId, sourceOrgName: names.get(sourceOrgId) ?? "", ...entry }))
    .sort((a, b) => a.sourceOrgName.localeCompare(b.sourceOrgName));
}

export type OpenedSharedItem = { item: SharedItemDetail; grant: ActiveGrant; sourceOrgName: string };

/**
 * Loads one shared item for a provider of `kase` and records `sharing.viewed` { grant_id, scope, item_id }.
 * Strict: if the audit row cannot be written the item is not returned (throws). null = not shared (-> 404).
 */
export async function openSharedItem(userId: string, kase: CaseRef, scope: ShareScope, itemId: string): Promise<OpenedSharedItem | null> {
  const loader = getShareLoader(scope);
  if (!loader) return null;
  const grants = await getActiveGrants(userId, kase.child_id, scope, kase.org_id);
  if (grants.length === 0) return null;
  const item = await loader.get({ childId: kase.child_id, sourceOrgIds: sourceOrgIdsOf(grants) }, itemId);
  if (!item) return null;
  const grant = grants.find((g) => g.source_org_id === item.sourceOrgId);
  if (!grant) return null;

  const { error } = await supabaseAdmin()
    .from("audit_events")
    .insert({
      case_id: kase.id,
      actor: "provider",
      actor_user_id: userId,
      action: "sharing.viewed",
      entity: "sharing_grant",
      entity_id: grant.grant_id,
      details: { grant_id: grant.grant_id, scope, item_id: item.id, source_org_id: item.sourceOrgId },
    });
  if (error) throw new Error(`Could not record the view: ${error.message}`);
  const names = await orgNames([item.sourceOrgId]);
  return { item, grant, sourceOrgName: names.get(item.sourceOrgId) ?? "" };
}
