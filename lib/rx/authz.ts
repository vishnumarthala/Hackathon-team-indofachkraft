// Ticket 039 NFR-1: resource-level gates for prescriptions. Server only.
// Providers: case access (022 rule; missing, malformed and other tenants' ids -> 404) AND the 028 prescriber rule on
// their OWN profile, derived in SQL on every request (`provider_can_prescribe`) -> otherwise 403
// `Only verified prescribers can write prescriptions`. Nothing from the request can enable prescribing.
// Guardians: an active link to the child (020) and a signed prescription published to guardians, else 404.
import { notFound } from "next/navigation";
import { getCaseAccessLevel, requireCasePage, requireChildGuardian, requireProviderApi, type Actor, type GuardianSession } from "@/lib/authz";
import { fail } from "@/lib/http";
import { caseOfPrescription, guardianDownloadable, prescriberProfileOf, type PrescriberProfile } from "./index";
import { MSG } from "./schema";

export type PrescriberGate = { actor: Actor; profile: PrescriberProfile; caseId: string };

/** `/api/cases/:id/prescriptions`: after `requireCaseActor(caseId)` (case access, 404), the prescriber rule (403). */
export async function requirePrescriber(actor: Actor, caseId: string): Promise<PrescriberGate | { response: Response }> {
  const profile = await prescriberProfileOf(actor.user.id);
  if (!profile?.can_prescribe) return { response: fail(403, MSG.notPrescriber) };
  return { actor, profile, caseId };
}

/** `/api/prescriptions/:id/**`: access to the prescription's case, then the prescriber rule. */
export async function requirePrescriptionActor(prescriptionId: string): Promise<PrescriberGate | { response: Response }> {
  const result = await requireProviderApi();
  if ("response" in result) return result;
  const caseId = await caseOfPrescription(prescriptionId);
  if (!caseId || !(await getCaseAccessLevel(result.actor.user.id, caseId))) return { response: fail(404, MSG.notFound) };
  return requirePrescriber(result.actor, caseId);
}

/** Case workspace `Prescriptions` tab: other cases 404 (requireCasePage), non-prescribers 404 too (tab hidden). */
export async function requirePrescriberCasePage(caseId: string): Promise<{ actor: Actor; profile: PrescriberProfile }> {
  const actor = await requireCasePage(caseId);
  const profile = await prescriberProfileOf(actor.user.id);
  if (!profile?.can_prescribe) notFound();
  return { actor, profile };
}

/** Guardian PDF download: signed + published to guardians + an active link to the child; anything else 404. */
export async function requireGuardianPrescription(prescriptionId: string, session: GuardianSession): Promise<{ childId: string } | Response> {
  const found = await guardianDownloadable(prescriptionId);
  if (!found) return fail(404, MSG.notFound);
  const access = await requireChildGuardian(found.childId, session);
  if (access instanceof Response) return access.status === 404 ? fail(404, MSG.notFound) : access;
  return found;
}
