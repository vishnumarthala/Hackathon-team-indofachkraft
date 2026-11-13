import { AuditWriteError, auditFailure } from "@/lib/audit";
import { fail, ok } from "@/lib/http";
import { schedulePendingTimetables } from "@/lib/import/schedule";
import { requireImportAccess } from "@/lib/import/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 044 extra scope: `Schedule saved timetables` - creates the weekly series (043) of this import's timetables that are
// still `pending`. Owner/admin of the import's organisation (members 403, others 404). Idempotent.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireImportAccess(id);
  if ("response" in gate) return gate.response;
  try {
    const outcome = await schedulePendingTimetables({ importId: id, actorUserId: gate.actor.user.id });
    return ok({ scheduled: outcome.scheduled, pending: outcome.pending });
  } catch (err) {
    if (err instanceof AuditWriteError) return auditFailure(err);
    console.error(`schedule pending timetables failed: ${err instanceof Error ? err.message : String(err)}`);
    return fail(503, "Could not schedule. Nothing was changed. Please try again.");
  }
}
