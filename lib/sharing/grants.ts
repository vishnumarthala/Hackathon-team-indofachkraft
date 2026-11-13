// Ticket 022 FR-4/FR-5: guardian-created sharing grants. Server only. Writes go through one database function
// each (grant/revoke + audit in one transaction, strict: an audit failure saves nothing -> 503).
import { z } from "zod";
import { isUuid } from "@/lib/cases/validation";
import { supabaseAdmin } from "@/lib/db";
import { drainSoon } from "@/lib/notify/outbox";
import type { Result } from "@/lib/orgs";
import { SHARE_SCOPES, type ShareScope } from "@/lib/sharing/scopes";

export const NOT_TREATING = "This organisation is not treating your child";
export const SAVE_FAILED = "Could not save. Please try again.";
export const GRANT_NOT_FOUND = "Sharing not found";

const orgId = (message: string) => z.string({ error: message }).refine(isUuid, { error: message });

export const GrantCreateSchema = z.object({
  source_org_id: orgId("Choose the organisation that shares"),
  grantee_org_id: orgId("Choose the organisation that receives"),
  scopes: z
    .array(z.enum(SHARE_SCOPES, { error: "Unknown record type" }), { error: "Choose what to share" })
    .min(1, { error: "Choose what to share" })
    .max(SHARE_SCOPES.length),
  expires_in_days: z
    .union([z.literal(90), z.literal(365), z.null()], { error: "Choose how long to share" })
    .optional()
    .transform((v) => v ?? null),
});
export type GrantCreateInput = z.output<typeof GrantCreateSchema>;

export type SharingGrant = {
  id: string;
  child_id: string;
  source_org_id: string;
  grantee_org_id: string;
  scopes: ShareScope[];
  granted_by: string | null;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
};

const GRANT_COLUMNS = "id, child_id, source_org_id, grantee_org_id, scopes, granted_by, created_at, expires_at, revoked_at, revoked_by";

const ERRORS: Record<string, { status: number; error: string }> = {
  child_not_found: { status: 404, error: "Child not found" },
  same_org: { status: 400, error: "Choose two different organisations" },
  no_case: { status: 422, error: NOT_TREATING },
  invalid: { status: 400, error: "Invalid request" },
};

export async function createSharingGrant(childId: string, userId: string, input: GrantCreateInput): Promise<Result<SharingGrant>> {
  try {
    const { data, error } = await supabaseAdmin().rpc("create_sharing_grant", {
      p_child: childId,
      p_source: input.source_org_id,
      p_grantee: input.grantee_org_id,
      p_scopes: input.scopes,
      p_expires_in_days: input.expires_in_days,
      p_user: userId,
    });
    if (error) {
      const code = /sharing:([a-z_]+)/.exec(error.message)?.[1];
      if (code && ERRORS[code]) return { ok: false, ...ERRORS[code] };
      console.error(`create_sharing_grant failed: ${error.message}`);
      return { ok: false, status: 503, error: SAVE_FAILED };
    }
    const grant = data as SharingGrant;
    // 032: the `sharing.granted` outbox event was enqueued by a trigger in the grant transaction; deliver it now.
    drainSoon();
    return { ok: true, data: grant };
  } catch (err) {
    console.error(`create_sharing_grant failed: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, status: 503, error: SAVE_FAILED };
  }
}

export async function revokeSharingGrant(childId: string, grantId: string, userId: string): Promise<Result<SharingGrant>> {
  if (!isUuid(grantId)) return { ok: false, status: 404, error: GRANT_NOT_FOUND };
  try {
    const { data, error } = await supabaseAdmin().rpc("revoke_sharing_grant", {
      p_child: childId,
      p_grant: grantId,
      p_user: userId,
    });
    if (error) {
      console.error(`revoke_sharing_grant failed: ${error.message}`);
      return { ok: false, status: 503, error: SAVE_FAILED };
    }
    const outcome = data as { result: "revoked" | "not_found"; grant?: SharingGrant };
    if (outcome.result !== "revoked" || !outcome.grant) return { ok: false, status: 404, error: GRANT_NOT_FOUND };
    return { ok: true, data: outcome.grant };
  } catch (err) {
    console.error(`revoke_sharing_grant failed: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, status: 503, error: SAVE_FAILED };
  }
}

/** Grants that are still in force (not revoked, not expired), newest first. Filtered in SQL. */
export async function listActiveChildGrants(childId: string, now: Date = new Date()): Promise<SharingGrant[]> {
  if (!isUuid(childId)) return [];
  const { data, error } = await supabaseAdmin()
    .from("sharing_grants")
    .select(GRANT_COLUMNS)
    .eq("child_id", childId)
    .is("revoked_at", null)
    .or(`expires_at.is.null,expires_at.gt.${now.toISOString()}`)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`Could not load sharing grants: ${error.message}`);
  return (data ?? []) as SharingGrant[];
}
