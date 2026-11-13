import { submitAssessment } from "@/lib/assessments";
import { requireGuardian } from "@/lib/authz";
import { fail, ok } from "@/lib/http";
import { drainSoon } from "@/lib/notify/outbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 024 FR-9: submit once every question is answered (422 lists the missing ones; already submitted -> 409).
// The score stays with the care team until they review and share a summary.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireGuardian();
  if (session instanceof Response) return session;
  const { id } = await params;

  const result = await submitAssessment({ assessmentId: id, userId: session.user.id });
  if (!result.ok) return fail(result.status, result.error, result.details);
  drainSoon(result.event_ids);
  return ok({ status: result.status, red_flags: result.red_flags });
}
