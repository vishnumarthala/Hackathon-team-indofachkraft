// Ticket 020 FR-8: consent checks. Server only. Every gated step calls requireConsent() (collection time) and
// every queued/async processor calls assertConsentOrAbort() right before data leaves for an external
// processor. Both fail closed: a database error counts as "no consent".
import { audit } from "@/lib/audit";
import { isUuid } from "@/lib/cases/validation";
import { supabaseAdmin } from "@/lib/db";
import { fail } from "@/lib/http";
import { CONSENT_FEATURES, CONSENT_REQUIRED_ERROR, type ConsentFeature } from "./features";

if (typeof window !== "undefined") {
  throw new Error("lib/consent is server-only");
}

export * from "./features";

export const CONSENT_WITHDRAWN = "consent_withdrawn";
export const CONSENT_CHECK_FAILED = "Could not check consent. Please try again.";
const RECORDINGS_BUCKET = "recordings";

export type ConsentStatus = {
  feature: ConsentFeature;
  granted: boolean;
  action: "granted" | "withdrawn" | null;
  method: "digital" | "paper" | null;
  at: string | null;
  record_id: string | null;
  consent_document_id: string | null;
  guardian_user_id: string | null;
  attested_by: string | null;
  paper_guardian_name: string | null;
  paper_signed_on: string | null;
  case_id: string | null;
};

export type ConsentState = Record<ConsentFeature, ConsentStatus>;

type StateRow = {
  feature: ConsentFeature;
  granted: boolean | null;
  action: "granted" | "withdrawn";
  method: "digital" | "paper";
  created_at: string;
  record_id: string;
  consent_document_id: string | null;
  guardian_user_id: string | null;
  attested_by: string | null;
  paper_guardian_name: string | null;
  paper_signed_on: string | null;
  case_id: string | null;
};

function emptyStatus(feature: ConsentFeature): ConsentStatus {
  return {
    feature,
    granted: false,
    action: null,
    method: null,
    at: null,
    record_id: null,
    consent_document_id: null,
    guardian_user_id: null,
    attested_by: null,
    paper_guardian_name: null,
    paper_signed_on: null,
    case_id: null,
  };
}

/** Current state of every feature for a child (latest record per feature; missing = not allowed). */
export async function getConsentState(childId: string): Promise<ConsentState> {
  const state = Object.fromEntries(CONSENT_FEATURES.map((f) => [f, emptyStatus(f)])) as ConsentState;
  if (!isUuid(childId)) return state;
  const db = supabaseAdmin();
  const [rows, child] = await Promise.all([
    db
      .from("child_consent_state")
      .select(
        "feature, granted, action, method, created_at, record_id, consent_document_id, guardian_user_id, attested_by, paper_guardian_name, paper_signed_on, case_id",
      )
      .eq("child_id", childId),
    db.from("children").select("deleted_at").eq("id", childId).maybeSingle(),
  ]);
  if (rows.error) throw new Error(`Could not load consent: ${rows.error.message}`);
  if (child.error) throw new Error(`Could not load child: ${child.error.message}`);
  const active = child.data !== null && (child.data as { deleted_at: string | null }).deleted_at === null;
  for (const row of (rows.data ?? []) as StateRow[]) {
    if (!(row.feature in state)) continue;
    state[row.feature] = {
      feature: row.feature,
      granted: active && row.granted === true,
      action: row.action,
      method: row.method,
      at: row.created_at,
      record_id: row.record_id,
      consent_document_id: row.consent_document_id,
      guardian_user_id: row.guardian_user_id,
      attested_by: row.attested_by,
      paper_guardian_name: row.paper_guardian_name,
      paper_signed_on: row.paper_signed_on,
      case_id: row.case_id,
    };
  }
  return state;
}

/** Throws on database errors (callers fail closed). */
export async function hasConsent(childId: string, feature: ConsentFeature): Promise<boolean> {
  if (!isUuid(childId)) return false;
  const db = supabaseAdmin();
  const [row, child] = await Promise.all([
    db.from("child_consent_state").select("granted").eq("child_id", childId).eq("feature", feature).maybeSingle(),
    db.from("children").select("deleted_at").eq("id", childId).maybeSingle(),
  ]);
  if (row.error) throw new Error(`Could not check consent: ${row.error.message}`);
  if (child.error) throw new Error(`Could not load child: ${child.error.message}`);
  if (!child.data || (child.data as { deleted_at: string | null }).deleted_at !== null) return false;
  return (row.data as { granted: boolean | null } | null)?.granted === true;
}

/** FR-8 body: 422 `{ error: "Guardian consent required", details: { feature, child_id } }`. */
export function consentRequired(childId: string | null, feature: ConsentFeature): Response {
  return fail(422, CONSENT_REQUIRED_ERROR, { feature, child_id: childId });
}

/** Collection-time gate: null when allowed, else the 422 (or 503 when consent could not be checked). */
export async function requireConsent(childId: string | null, feature: ConsentFeature): Promise<Response | null> {
  if (!childId) return consentRequired(null, feature);
  try {
    return (await hasConsent(childId, feature)) ? null : consentRequired(childId, feature);
  } catch (err) {
    console.error(`consent check failed: ${err instanceof Error ? err.message : String(err)}`);
    return fail(503, CONSENT_CHECK_FAILED);
  }
}

export async function childIdForCase(caseId: string): Promise<string | null> {
  if (!isUuid(caseId)) return null;
  const { data, error } = await supabaseAdmin().from("cases").select("child_id").eq("id", caseId).maybeSingle();
  if (error) throw new Error(`Could not load case: ${error.message}`);
  return (data as { child_id: string } | null)?.child_id ?? null;
}

/** requireConsent() for the child of a case (call after the case access gate). */
export async function requireCaseConsent(caseId: string, feature: ConsentFeature): Promise<Response | null> {
  let childId: string | null;
  try {
    childId = await childIdForCase(caseId);
  } catch (err) {
    console.error(`consent check failed: ${err instanceof Error ? err.message : String(err)}`);
    return fail(503, CONSENT_CHECK_FAILED);
  }
  return requireConsent(childId, feature);
}

export type AbortContext = {
  stage: string;
  caseId?: string | null;
  recordingId?: string | null;
  /** Mark the recording `failed` with error `consent_withdrawn`. */
  markRecordingFailed?: boolean;
  /** Audio not processed yet: deleted from storage when the step is aborted. */
  audioPath?: string | null;
};

/**
 * FR-8 re-check for queued/async work. Returns true when processing may continue. Otherwise it marks the
 * recording failed (`consent_withdrawn`), deletes unprocessed audio, audits `consent.blocked_processing`
 * and returns false: the caller must not send anything to the external processor.
 */
export async function assertConsentOrAbort(
  childId: string | null,
  feature: ConsentFeature,
  context: AbortContext,
): Promise<boolean> {
  let granted = false;
  try {
    granted = childId !== null && (await hasConsent(childId, feature));
  } catch (err) {
    console.error(`consent re-check failed (blocking): ${err instanceof Error ? err.message : String(err)}`);
    granted = false;
  }
  if (granted) return true;

  const db = supabaseAdmin();
  let audioDeleted = false;
  if (context.audioPath) {
    const { error } = await db.storage.from(RECORDINGS_BUCKET).remove([context.audioPath]);
    if (error) console.error(`could not delete unprocessed audio: ${error.message}`);
    else audioDeleted = true;
  }
  if (context.markRecordingFailed && context.recordingId) {
    const { error } = await db
      .from("recordings")
      .update({ status: "failed", error: CONSENT_WITHDRAWN, ...(audioDeleted ? { storage_path: null } : {}) })
      .eq("id", context.recordingId);
    if (error) console.error(`could not mark recording failed: ${error.message}`);
  }
  await audit({
    caseId: context.caseId ?? null,
    actor: "system",
    action: "consent.blocked_processing",
    entity: context.recordingId ? "recording" : "child",
    entityId: context.recordingId ?? childId ?? undefined,
    details: { child_id: childId, feature, stage: context.stage, audio_deleted: audioDeleted },
  });
  return false;
}

export type PublicConsentStatus = {
  granted: boolean;
  action: "granted" | "withdrawn" | null;
  method: "digital" | "paper" | null;
  at: string | null;
  paper_signed_on: string | null;
  consent_document_id: string | null;
};

/** API shape of the consent state (no internal user ids). */
export function publicConsentState(state: ConsentState): Record<ConsentFeature, PublicConsentStatus> {
  return Object.fromEntries(
    CONSENT_FEATURES.map((f) => {
      const s = state[f];
      return [
        f,
        {
          granted: s.granted,
          action: s.action,
          method: s.method,
          at: s.at,
          paper_signed_on: s.paper_signed_on,
          consent_document_id: s.consent_document_id,
        },
      ];
    }),
  ) as Record<ConsentFeature, PublicConsentStatus>;
}
