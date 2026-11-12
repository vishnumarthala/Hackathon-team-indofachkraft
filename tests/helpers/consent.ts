// Ticket 020 test helpers. Synthetic data only.
import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { vi } from "vitest";
import { CONSENT_FEATURES, CONSENT_REQUIRED_ERROR } from "@/lib/consent/features";

/**
 * `vi.mock("@/lib/consent", async () => (await import("./helpers/consent")).consentAllowedModule())` for route
 * unit tests that mock the database: every consent check passes (the gates themselves are covered by
 * tests/consent-*.test.ts against the database).
 */
export async function consentAllowedModule() {
  const features = await vi.importActual<typeof import("@/lib/consent/features")>("@/lib/consent/features");
  return {
    ...features,
    CONSENT_WITHDRAWN: "consent_withdrawn",
    requireConsent: vi.fn(async () => null),
    requireCaseConsent: vi.fn(async () => null),
    assertConsentOrAbort: vi.fn(async () => true),
    hasConsent: vi.fn(async () => true),
    childIdForCase: vi.fn(async () => "00000000-0000-4000-8000-00000000c001"),
    consentRequired: (childId: string | null, feature: string) =>
      Response.json({ error: CONSENT_REQUIRED_ERROR, details: { feature, child_id: childId } }, { status: 422 }),
  };
}

/**
 * Grants synthetic paper consent for the child of `caseId` through the real `record_consent` function
 * (user_agent `seed:synthetic`). For DB suites whose cases need consent to keep exercising the pipeline.
 */
export async function grantSyntheticConsent(sql: Sql, caseId: string, features: readonly string[] = CONSENT_FEATURES) {
  const [kase] = await sql<{ child_id: string }[]>`select child_id from cases where id = ${caseId}`;
  const docs = await sql<{ id: string }[]>`
    select distinct on (feature) id from consent_documents
    where locale = 'en' and feature in ${sql(features as string[])} order by feature, version desc`;
  await sql`select public.record_consent(${sql.json({
    child_id: kase.child_id,
    action: "granted",
    method: "paper",
    features,
    document_ids: docs.map((d) => d.id),
    attested_by: randomUUID(),
    paper_guardian_name: "Synthetic parent",
    paper_relationship: "mother",
    paper_signed_on: new Date().toISOString().slice(0, 10),
    paper_form_path: "seed:synthetic",
    user_agent: "seed:synthetic",
    case_id: caseId,
  })}::jsonb)`;
  return kase.child_id;
}

/**
 * Removes synthetic children and their append-only consent rows. Local test databases only: the append-only
 * trigger is bypassed with `session_replication_role = replica` (superuser) inside one transaction.
 */
export async function purgeSyntheticChildren(sql: Sql, childIds: string[]) {
  const ids = childIds.filter(Boolean);
  if (ids.length === 0) return;
  await sql.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`delete from consent_records where child_id in ${tx(ids)}`;
    await tx`delete from child_claim_codes where child_id in ${tx(ids)}`;
    await tx`delete from guardian_links where child_id in ${tx(ids)}`;
    await tx`delete from children where id in ${tx(ids)} and not exists (select 1 from cases c where c.child_id = children.id)`;
  });
}
