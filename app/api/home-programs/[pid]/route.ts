import { AuditWriteError, auditFailure } from "@/lib/audit";
import { getProgramDetail, updateProgram } from "@/lib/home-program";
import { requireHomeProgramActor } from "@/lib/home-program/authz";
import { MSG, ProgramPatchSchema } from "@/lib/home-program/schema";
import { fail, ok, parseJson } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 026 FR-2/FR-4: one program with its activities (incl. stopped ones) and adherence (case access, else 404).
export async function GET(_req: Request, { params }: { params: Promise<{ pid: string }> }) {
  const { pid } = await params;
  const gate = await requireHomeProgramActor(pid);
  if ("response" in gate) return gate.response;
  const detail = await getProgramDetail(pid, gate.caseId);
  if (!detail) return fail(404, MSG.programNotFound);
  return ok(detail);
}

// 026 FR-2: `{ title?, status?: "archived", version }`; stale version -> 409.
export async function PATCH(req: Request, { params }: { params: Promise<{ pid: string }> }) {
  const { pid } = await params;
  const gate = await requireHomeProgramActor(pid);
  if ("response" in gate) return gate.response;
  const parsed = await parseJson(req, ProgramPatchSchema);
  if ("response" in parsed) return parsed.response;

  let result: Awaited<ReturnType<typeof updateProgram>>;
  try {
    result = await updateProgram({ programId: pid, actorUserId: gate.actor.user.id, body: parsed.data });
  } catch (err) {
    if (err instanceof AuditWriteError) return auditFailure(err);
    throw err;
  }
  if (!result.ok) return fail(result.status, result.error, result.details);
  return ok({ program: result.program });
}
