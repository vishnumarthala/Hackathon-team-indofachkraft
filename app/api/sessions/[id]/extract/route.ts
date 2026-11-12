import { runExtraction, type ExtractionOutcome } from "@/lib/extraction";
import { requireRecordingAccess } from "@/lib/authz";
import { requireCaseConsent } from "@/lib/consent";
import { getRecording } from "@/lib/queries/recordings";
import { fail, ok } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const denied = await requireRecordingAccess(id);
  if (denied) return denied;
  const recording = await getRecording(id);
  if (!recording) return fail(404, "Session not found");
  const blocked = await requireCaseConsent(recording.case_id, "ai_extraction");
  if (blocked) return blocked;
  let outcome: ExtractionOutcome;
  try {
    outcome = await runExtraction(id);
  } catch (err) {
    console.error(`extraction could not start for ${id}: ${err instanceof Error ? err.message : String(err)}`);
    return fail(500, "Could not start extraction");
  }
  if (!outcome.ok) return fail(outcome.status, outcome.error, outcome.details);
  return ok(outcome.body);
}
