// Ticket 026: resource-level gates for home programs (022 case-access rule; design rule 3). Server only.
// Missing, malformed and other tenants' ids all give the same 404; guardians on provider APIs 403; anonymous 401.
// Guardian gates check the activity is in the CURRENT published snapshot and the guardian's active link to the child.
import { getCaseAccessLevel, requireChildGuardian, requireProviderApi, type Actor, type GuardianSession } from "@/lib/authz";
import { isUuid } from "@/lib/cases/validation";
import { findPublishedActivity } from "@/lib/home-program";
import { MSG } from "@/lib/home-program/schema";
import { fail } from "@/lib/http";
import { pg as db } from "@/lib/pg";

async function caseOfProgram(programId: string): Promise<string | null> {
  if (!isUuid(programId)) return null;
  const sql = await db();
  const [row] = await sql<{ case_id: string }[]>`select case_id from home_programs where id = ${programId}`;
  return row?.case_id ?? null;
}

async function programOfActivity(activityId: string): Promise<{ program_id: string; case_id: string } | null> {
  if (!isUuid(activityId)) return null;
  const sql = await db();
  const [row] = await sql<{ program_id: string; case_id: string }[]>`
    select a.program_id, p.case_id from home_activities a join home_programs p on p.id = a.program_id where a.id = ${activityId}`;
  return row ?? null;
}

/** Provider access to a home program = access to its case. */
export async function requireHomeProgramActor(
  programId: string,
): Promise<{ actor: Actor; caseId: string } | { response: Response }> {
  const result = await requireProviderApi();
  if ("response" in result) return result;
  const caseId = await caseOfProgram(programId);
  if (!caseId || !(await getCaseAccessLevel(result.actor.user.id, caseId))) return { response: fail(404, MSG.programNotFound) };
  return { actor: result.actor, caseId };
}

/** Provider access to an activity = access to its program's case. */
export async function requireHomeActivityActor(
  activityId: string,
): Promise<{ actor: Actor; caseId: string; programId: string } | { response: Response }> {
  const result = await requireProviderApi();
  if ("response" in result) return result;
  const ref = await programOfActivity(activityId);
  if (!ref || !(await getCaseAccessLevel(result.actor.user.id, ref.case_id))) return { response: fail(404, MSG.activityNotFound) };
  return { actor: result.actor, caseId: ref.case_id, programId: ref.program_id };
}

/**
 * Guardian access to an activity: active and in the current published snapshot (draft, unpublished, stopped,
 * archived -> 404) AND an active link to the program's child (other families -> 404).
 */
export async function requireGuardianActivity(
  activityId: string,
  session: GuardianSession,
): Promise<{ activityId: string; programId: string; caseId: string; childId: string } | Response> {
  const found = await findPublishedActivity(activityId);
  if (!found) return fail(404, MSG.activityNotFound);
  const access = await requireChildGuardian(found.childId, session);
  if (access instanceof Response) return access.status === 404 ? fail(404, MSG.activityNotFound) : access;
  return found;
}
