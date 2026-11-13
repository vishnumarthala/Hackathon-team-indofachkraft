import { auditFailure, AuditWriteError } from "@/lib/audit";
import { requireChildGuardian, requireGuardian } from "@/lib/authz";
import { requireConsent } from "@/lib/consent";
import { fail, ok, parseJson } from "@/lib/http";
import { SaveResultSchema } from "@/lib/screen/questions";
import { saveScreenResult } from "@/lib/screen/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Ticket 033 FR-8: a signed-in guardian saves a finished public check-in to one of their children.
// Order: guardian session (401/403) -> active link to the child (404 for anyone else's child) -> 020 consent
// `screen_result_save` (422, the page shows an inline `Allow` dialog) -> the session (404/409/410).
export async function POST(req: Request) {
  const session = await requireGuardian();
  if (session instanceof Response) return session;
  const parsed = await parseJson(req, SaveResultSchema);
  if ("response" in parsed) return parsed.response;
  const { session_id, child_id } = parsed.data;

  const access = await requireChildGuardian(child_id, session);
  if (access instanceof Response) return access;
  const blocked = await requireConsent(access.child.id, "screen_result_save");
  if (blocked) return blocked;

  let saved: Awaited<ReturnType<typeof saveScreenResult>>;
  try {
    saved = await saveScreenResult({ sessionId: session_id, childId: access.child.id, userId: session.user.id });
  } catch (err) {
    if (err instanceof AuditWriteError) return auditFailure(err);
    throw err;
  }
  if (!saved.ok) return fail(saved.status, saved.error, saved.details);
  return ok({ saved: true, session_id, child_id: access.child.id }, saved.created ? 201 : 200);
}
