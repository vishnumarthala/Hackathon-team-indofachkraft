import { requireCaseActor } from "@/lib/authz";
import {
  addAssignment,
  AssignmentCreateSchema,
  canManageCaseTeam,
  listCaseTeam,
  TEAM_MANAGERS_ONLY,
} from "@/lib/cases/team";
import { fail, ok, parseJson } from "@/lib/http";

export const dynamic = "force-dynamic";

// 022 FR-3: the case's care team. Anyone with access to the case reads it.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireCaseActor(id);
  if ("response" in gate) return gate.response;
  return ok({ assignments: await listCaseTeam(id) });
}

// 022 FR-3: owners/admins of the case's org and the case lead add a provider of the same org.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireCaseActor(id);
  if ("response" in gate) return gate.response;
  if (!(await canManageCaseTeam(gate.actor.user.id, id))) return fail(403, TEAM_MANAGERS_ONLY);

  const parsed = await parseJson(req, AssignmentCreateSchema);
  if ("response" in parsed) return parsed.response;
  const result = await addAssignment(id, gate.actor.user.id, parsed.data);
  if (!result.ok) return fail(result.status, result.error);
  const assignment = (await listCaseTeam(id)).find((a) => a.assignment_id === result.data.id) ?? { assignment_id: result.data.id };
  return ok({ assignment }, 201);
}
