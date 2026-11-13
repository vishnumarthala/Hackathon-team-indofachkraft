// Ticket 022 FR-1/FR-3: the care team of a case (provider assignments). Server only.
// Discipline: free text (`discipline_label`); when empty, the UI shows the provider's 028 `provider_type`
// (translated) if they have a profile. Access rule (D-1): org owners/admins reach every case of their org; members only cases they are assigned to.
// Writes go through database functions (team change + audit row in one transaction; the case row lock
// serialises concurrent changes, so a case never ends up with zero or two leads).
import { z } from "zod";
import { isUuid } from "@/lib/cases/validation";
import { supabaseAdmin } from "@/lib/db";
import type { Result } from "@/lib/orgs";
import type { ProviderType } from "@/lib/providers/constants";

export const CARE_ROLES = ["lead", "member"] as const;
export type CareRole = (typeof CARE_ROLES)[number];

export const NOT_IN_ORG = "This person is not in your organisation";
export const LAST_LEAD = "Assign another lead first";
export const ALREADY_ON_TEAM = "This person is already on the care team";
export const ASSIGNMENT_NOT_FOUND = "Assignment not found";
export const TEAM_MANAGERS_ONLY = "Only the case lead or an organisation owner or admin can change the care team";

const label = z
  .string({ error: "Discipline must be text" })
  .trim()
  .max(60, { error: "Discipline must be at most 60 characters" })
  .nullish()
  .transform((v) => (v ? v : null));

export const AssignmentCreateSchema = z.object({
  user_id: z.string({ error: "Choose a provider" }).refine(isUuid, { error: "Choose a provider" }),
  care_role: z.enum(CARE_ROLES, { error: "Choose lead or member" }).optional().default("member"),
  discipline_label: label,
});

export const AssignmentUpdateSchema = z
  .object({ care_role: z.enum(CARE_ROLES, { error: "Choose lead or member" }).optional(), discipline_label: label.optional() })
  .refine((v) => v.care_role !== undefined || v.discipline_label !== undefined, { error: "Nothing to update" });

export type TeamMember = {
  assignment_id: string;
  user_id: string;
  care_role: CareRole;
  discipline_label: string | null;
  assigned_at: string;
  display_name: string | null;
  email: string | null;
  provider_type: ProviderType | null;
  member_active: boolean;
};

export type TeamCandidate = {
  user_id: string;
  display_name: string | null;
  email: string | null;
  provider_type: ProviderType | null;
  org_role: "owner" | "admin" | "member";
};

export async function listCaseTeam(caseId: string): Promise<TeamMember[]> {
  if (!isUuid(caseId)) return [];
  const { data, error } = await supabaseAdmin().rpc("list_case_team", { p_case: caseId });
  if (error) throw new Error(`Could not load the care team: ${error.message}`);
  return (data ?? []) as TeamMember[];
}

export async function listTeamCandidates(caseId: string): Promise<TeamCandidate[]> {
  if (!isUuid(caseId)) return [];
  const { data, error } = await supabaseAdmin().rpc("list_case_team_candidates", { p_case: caseId });
  if (error) throw new Error(`Could not load organisation members: ${error.message}`);
  return (data ?? []) as TeamCandidate[];
}

export async function canManageCaseTeam(userId: string, caseId: string): Promise<boolean> {
  if (!isUuid(caseId)) return false;
  const { data, error } = await supabaseAdmin().rpc("can_manage_case_team", { p_user: userId, p_case: caseId });
  if (error) throw new Error(`Could not check care team rights: ${error.message}`);
  return data === true;
}

type Outcome = { result: string; id?: string; user_id?: string };

async function call(fn: string, args: Record<string, unknown>): Promise<Outcome> {
  const { data, error } = await supabaseAdmin().rpc(fn, args);
  if (error) throw new Error(`${fn} failed: ${error.message}`);
  return data as Outcome;
}

export async function addAssignment(
  caseId: string,
  actorId: string,
  input: z.output<typeof AssignmentCreateSchema>,
): Promise<Result<{ id: string }>> {
  const outcome = await call("add_case_assignment", {
    p_case: caseId,
    p_user: input.user_id,
    p_care_role: input.care_role,
    p_discipline_label: input.discipline_label,
    p_actor: actorId,
  });
  switch (outcome.result) {
    case "added":
      return { ok: true, data: { id: outcome.id as string } };
    case "not_member":
      return { ok: false, status: 422, error: NOT_IN_ORG };
    case "duplicate":
      return { ok: false, status: 409, error: ALREADY_ON_TEAM };
    default:
      return { ok: false, status: 404, error: "Case not found" };
  }
}

export async function updateAssignment(
  caseId: string,
  assignmentId: string,
  actorId: string,
  input: z.output<typeof AssignmentUpdateSchema>,
): Promise<Result<{ id: string }>> {
  if (!isUuid(assignmentId)) return { ok: false, status: 404, error: ASSIGNMENT_NOT_FOUND };
  const outcome = await call("update_case_assignment", {
    p_case: caseId,
    p_assignment: assignmentId,
    p_care_role: input.care_role ?? null,
    p_discipline_label: input.discipline_label ?? null,
    p_set_label: input.discipline_label !== undefined,
    p_actor: actorId,
  });
  if (outcome.result === "updated") return { ok: true, data: { id: assignmentId } };
  if (outcome.result === "last_lead") return { ok: false, status: 409, error: LAST_LEAD };
  return { ok: false, status: 404, error: ASSIGNMENT_NOT_FOUND };
}

export async function removeAssignment(caseId: string, assignmentId: string, actorId: string): Promise<Result<{ id: string }>> {
  if (!isUuid(assignmentId)) return { ok: false, status: 404, error: ASSIGNMENT_NOT_FOUND };
  const outcome = await call("remove_case_assignment", { p_case: caseId, p_assignment: assignmentId, p_actor: actorId });
  if (outcome.result === "removed") return { ok: true, data: { id: assignmentId } };
  if (outcome.result === "last_lead") return { ok: false, status: 409, error: LAST_LEAD };
  return { ok: false, status: 404, error: ASSIGNMENT_NOT_FOUND };
}

export type ChildCareTeamRow = {
  org_id: string;
  org_name: string;
  user_id: string | null;
  display_name: string | null;
  provider_type: ProviderType | null;
  discipline_label: string | null;
  care_role: CareRole | null;
};

export type ChildCareTeamOrg = {
  org_id: string;
  org_name: string;
  providers: {
    user_id: string;
    display_name: string | null;
    discipline_label: string | null;
    provider_type: ProviderType | null;
    care_role: CareRole;
  }[];
};

/** FR-4: organisations with a case for the child and their active care teams (guardian view, no emails). */
export async function listChildCareTeam(childId: string): Promise<ChildCareTeamOrg[]> {
  if (!isUuid(childId)) return [];
  const { data, error } = await supabaseAdmin().rpc("list_child_care_team", { p_child: childId });
  if (error) throw new Error(`Could not load the care team: ${error.message}`);
  const orgs: ChildCareTeamOrg[] = [];
  for (const row of (data ?? []) as ChildCareTeamRow[]) {
    let org = orgs.find((o) => o.org_id === row.org_id);
    if (!org) {
      org = { org_id: row.org_id, org_name: row.org_name, providers: [] };
      orgs.push(org);
    }
    if (row.user_id && row.care_role) {
      org.providers.push({
        user_id: row.user_id,
        display_name: row.display_name,
        discipline_label: row.discipline_label,
        provider_type: row.provider_type,
        care_role: row.care_role,
      });
    }
  }
  return orgs;
}
