import { AuditWriteError, auditFailure } from "@/lib/audit";
import { publishProgram } from "@/lib/home-program";
import { requireHomeProgramActor } from "@/lib/home-program/authz";
import { PublishSchema } from "@/lib/home-program/schema";
import { fail, ok, parseJson } from "@/lib/http";
import { drainSoon } from "@/lib/notify/outbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 026 FR-3: `Publish to parent` / `Publish changes` `{ version }` -> 200. Makes the program the case's published one
// (archiving the previous), publishes a guardian-visible version (024) and notifies the guardians (032).
export async function POST(req: Request, { params }: { params: Promise<{ pid: string }> }) {
  const { pid } = await params;
  const gate = await requireHomeProgramActor(pid);
  if ("response" in gate) return gate.response;
  const parsed = await parseJson(req, PublishSchema);
  if ("response" in parsed) return parsed.response;

  let result: Awaited<ReturnType<typeof publishProgram>>;
  try {
    result = await publishProgram({ programId: pid, actorUserId: gate.actor.user.id, version: parsed.data.version });
  } catch (err) {
    if (err instanceof AuditWriteError) return auditFailure(err);
    throw err;
  }
  if (!result.ok) return fail(result.status, result.error, result.details);
  drainSoon(result.event_ids);
  return ok({
    published_version: result.published.version,
    published_at: result.published.published_at,
    program: result.program,
    archived_program_id: result.archived_program_id,
  });
}
