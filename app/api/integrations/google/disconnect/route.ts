import { auditActorOf, auditFailure, AuditWriteError } from "@/lib/audit";
import { requireProviderContext } from "@/lib/booking/authz";
import { disconnectGoogle } from "@/lib/google/connections";
import { fail, ok } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 037 FR-2 `Disconnect`: revokes the token at Google and deletes it. Own profile only (resolved server-side).
// 200 { disconnected: true, revoked } / 404 when there is no connection.
export async function POST() {
  const gate = await requireProviderContext();
  if ("response" in gate) return gate.response;
  try {
    const result = await disconnectGoogle({ providerProfileId: gate.ctx.profile.id, actor: auditActorOf(gate.actor.user, gate.actor.role) });
    if (!result.disconnected) return fail(404, "Google Calendar is not connected");
    return ok(result);
  } catch (err) {
    if (err instanceof AuditWriteError) return auditFailure(err);
    throw err;
  }
}
