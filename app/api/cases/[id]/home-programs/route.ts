import { requireCaseActor } from "@/lib/authz";
import { createProgram, listCasePrograms } from "@/lib/home-program";
import { ProgramCreateSchema } from "@/lib/home-program/schema";
import { fail, ok, parseJson } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 026 FR-2: home programs of the case (anyone with case access), published first, with publish state.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireCaseActor(id);
  if ("response" in gate) return gate.response;
  return ok({ programs: await listCasePrograms(id) });
}

// 026 FR-2: create a draft program `{ title }` -> 201 { program } (linked to the case's active IEP plan, if any).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireCaseActor(id);
  if ("response" in gate) return gate.response;
  const parsed = await parseJson(req, ProgramCreateSchema);
  if ("response" in parsed) return parsed.response;

  const result = await createProgram({ caseId: id, actorUserId: gate.actor.user.id, body: parsed.data });
  if (!result.ok) return fail(result.status, result.error, result.details);
  return ok({ program: result.program }, 201);
}
