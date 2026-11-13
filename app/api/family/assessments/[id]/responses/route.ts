import { saveResponses } from "@/lib/assessments";
import { ResponsesSchema } from "@/lib/assessments/schemas";
import { requireGuardian } from "@/lib/authz";
import { fail, ok, parseJson } from "@/lib/http";
import { ASSESSMENT_TOPICS, notifyLater } from "@/lib/notify/topics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 024 FR-9: `Save and continue later`. Only the assigned guardian (active link); stale `version` -> 409.
// A red-flag question newly answered `yes` notifies the care team (`assessment.red_flag`).
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireGuardian();
  if (session instanceof Response) return session;
  const { id } = await params;
  const parsed = await parseJson(req, ResponsesSchema);
  if ("response" in parsed) return parsed.response;

  const result = await saveResponses({ assessmentId: id, userId: session.user.id, body: parsed.data });
  if (!result.ok) return fail(result.status, result.error, result.details);
  if (result.new_red_flags.length > 0) {
    await notifyLater(ASSESSMENT_TOPICS.redFlag, {
      assessment_id: id,
      case_id: result.case_id,
      codes: result.new_red_flags.join(","),
    });
  }
  return ok({ version: result.version, status: result.status, red_flags: result.red_flags });
}
