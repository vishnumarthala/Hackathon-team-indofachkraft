import { AuditWriteError, auditFailure } from "@/lib/audit";
import { addActivity } from "@/lib/home-program";
import { requireHomeProgramActor } from "@/lib/home-program/authz";
import { ActivityCreateSchema } from "@/lib/home-program/schema";
import { fail, ok, parseJson } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 026 FR-2: add an activity `{ title, instructions_md, frequency_per_week, duration_min, materials?, goal_id?,
// document_id?, version? }` -> 201 { activity, program_version }. A goal outside the case's active plan -> 422.
export async function POST(req: Request, { params }: { params: Promise<{ pid: string }> }) {
  const { pid } = await params;
  const gate = await requireHomeProgramActor(pid);
  if ("response" in gate) return gate.response;
  const parsed = await parseJson(req, ActivityCreateSchema);
  if ("response" in parsed) return parsed.response;

  let result: Awaited<ReturnType<typeof addActivity>>;
  try {
    result = await addActivity({ programId: pid, actorUserId: gate.actor.user.id, body: parsed.data });
  } catch (err) {
    if (err instanceof AuditWriteError) return auditFailure(err);
    throw err;
  }
  if (!result.ok) return fail(result.status, result.error, result.details);
  return ok({ activity: result.activity, program_version: result.program_version }, 201);
}
