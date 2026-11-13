import { requireCaseActor } from "@/lib/authz";
import {
  AssignmentUpdateSchema,
  canManageCaseTeam,
  listCaseTeam,
  removeAssignment,
  TEAM_MANAGERS_ONLY,
  updateAssignment,
} from "@/lib/cases/team";
import { fail, ok, parseJson } from "@/lib/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string; assignmentId: string }> };

// 022 FR-3: change the care role (making someone lead hands the lead over) or the discipline label.
export async function PATCH(req: Request, { params }: Params) {
  const { id, assignmentId } = await params;
  const gate = await requireCaseActor(id);
  if ("response" in gate) return gate.response;
  if (!(await canManageCaseTeam(gate.actor.user.id, id))) return fail(403, TEAM_MANAGERS_ONLY);

  const parsed = await parseJson(req, AssignmentUpdateSchema);
  if ("response" in parsed) return parsed.response;
  const result = await updateAssignment(id, assignmentId, gate.actor.user.id, parsed.data);
  if (!result.ok) return fail(result.status, result.error);
  const assignment = (await listCaseTeam(id)).find((a) => a.assignment_id === assignmentId) ?? { assignment_id: assignmentId };
  return ok({ assignment });
}

// 022 FR-3/FR-7: removing someone ends their access to the case on their next request. The lead stays
// until another lead is assigned (409).
export async function DELETE(_req: Request, { params }: Params) {
  const { id, assignmentId } = await params;
  const gate = await requireCaseActor(id);
  if ("response" in gate) return gate.response;
  if (!(await canManageCaseTeam(gate.actor.user.id, id))) return fail(403, TEAM_MANAGERS_ONLY);

  const result = await removeAssignment(id, assignmentId, gate.actor.user.id);
  if (!result.ok) return fail(result.status, result.error);
  return ok({ removed: true, assignment_id: assignmentId });
}
