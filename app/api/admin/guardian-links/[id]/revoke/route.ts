import { audit } from "@/lib/audit";
import { getAuthenticatedUser, getUserRole } from "@/lib/auth";
import { isUuid } from "@/lib/cases/validation";
import { supabaseAdmin } from "@/lib/db";
import { fail, ok } from "@/lib/http";

export const dynamic = "force-dynamic";

// 020 FR-16: a platform admin revokes a guardian link (e.g. a court order); effective on the next request.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthenticatedUser();
  if (!user) return fail(401, "Authentication required");
  if ((await getUserRole(user.id)) !== "platform_admin") return fail(404, "Not found");
  const { id } = await params;
  if (!isUuid(id)) return fail(404, "Not found");
  const { data, error } = await supabaseAdmin()
    .from("guardian_links")
    .update({ status: "revoked", revoked_at: new Date().toISOString(), revoked_by: user.id })
    .eq("id", id)
    .eq("status", "active")
    .select("id, child_id");
  if (error) return fail(503, "Could not save. Please try again.");
  const row = (data ?? [])[0] as { id: string; child_id: string } | undefined;
  if (!row) return fail(404, "Not found");
  await audit({
    actor: "system",
    actorUserId: user.id,
    action: "guardian.link_revoked",
    entity: "guardian_link",
    entityId: row.id,
    details: { child_id: row.child_id },
  });
  return ok({ revoked: true });
}
