// Ticket 020 FR-4/FR-5/FR-13/FR-17/FR-18: consent documents and the strict write path. Server only.
import { createHash } from "node:crypto";
import { supabaseAdmin } from "@/lib/db";
import { env } from "@/lib/env";
import type { Locale } from "@/lib/i18n/config";
import { CONSENT_FEATURES, type ConsentFeature, type Relationship } from "./features";

if (typeof window !== "undefined") {
  throw new Error("lib/consent/records.ts is server-only");
}

export type Processor = { name: string; purpose: string; location: string };

export type ConsentDocument = {
  id: string;
  feature: ConsentFeature;
  version: number;
  locale: Locale;
  title: string;
  body_md: string;
  processors: Processor[];
  published_at: string;
};

const DOC_COLUMNS = "id, feature, version, locale, title, body_md, processors, published_at";

/** The latest published version of every feature in one locale, in FR-7 order. */
export async function currentDocuments(locale: Locale): Promise<ConsentDocument[]> {
  const { data, error } = await supabaseAdmin()
    .from("consent_documents")
    .select(DOC_COLUMNS)
    .eq("locale", locale)
    .order("version", { ascending: false });
  if (error) throw new Error(`Could not load consent texts: ${error.message}`);
  const latest = new Map<string, ConsentDocument>();
  for (const doc of (data ?? []) as ConsentDocument[]) if (!latest.has(doc.feature)) latest.set(doc.feature, doc);
  return CONSENT_FEATURES.map((f) => latest.get(f)).filter((d): d is ConsentDocument => d !== undefined);
}

export async function documentsByIds(ids: string[]): Promise<ConsentDocument[]> {
  if (ids.length === 0) return [];
  const { data, error } = await supabaseAdmin().from("consent_documents").select(DOC_COLUMNS).in("id", ids);
  if (error) throw new Error(`Could not load consent texts: ${error.message}`);
  return (data ?? []) as ConsentDocument[];
}

/** True when `doc` is the newest version of its feature in its locale. */
export async function isCurrentDocument(doc: Pick<ConsentDocument, "feature" | "locale" | "version">): Promise<boolean> {
  const { data, error } = await supabaseAdmin()
    .from("consent_documents")
    .select("version")
    .eq("feature", doc.feature)
    .eq("locale", doc.locale)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Could not load consent texts: ${error.message}`);
  return (data as { version: number } | null)?.version === doc.version;
}

/** sha256 of the client IP and a server salt (FR-5): the raw IP is never stored. */
export function hashIp(ip: string): string {
  const salt = env.CONSENT_IP_SALT ?? env.SUPABASE_SERVICE_ROLE_KEY;
  return createHash("sha256").update(`${salt}:${ip}`).digest("hex");
}

export function requestMeta(req: Request): { ip_hash: string; user_agent: string | null } {
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = forwarded || req.headers.get("x-real-ip")?.trim() || "unknown";
  const agent = req.headers.get("user-agent");
  return { ip_hash: hashIp(ip), user_agent: agent ? agent.slice(0, 200) : null };
}

export type RecordConsentInput = {
  childId: string;
  action: "granted" | "withdrawn";
  features: ConsentFeature[];
  documentIds?: string[];
  locale?: Locale;
  caseId?: string | null;
  ipHash?: string | null;
  userAgent?: string | null;
} & (
  | { method: "digital"; guardianUserId: string; guardianLinkId: string }
  | {
      method: "paper";
      attestedBy: string;
      paperGuardianName: string;
      paperRelationship?: Relationship | null;
      paperSignedOn?: string | null;
      paperFormPath?: string | null;
      paperNote?: string | null;
    }
);

export type RecordConsentResult = { ok: true; recordIds: string[] } | { ok: false; status: number; error: string };

export const SAVE_FAILED = "Could not save. Please try again.";
export const OUTDATED_TEXT = "Please review the updated text";
export const VERIFY_PHONE = "Verify your mobile number before giving permission";

const ERRORS: Record<string, { status: number; error: string }> = {
  outdated_document: { status: 409, error: OUTDATED_TEXT },
  phone_unverified: { status: 422, error: VERIFY_PHONE },
  link_inactive: { status: 404, error: "Child not found" },
  child_not_found: { status: 404, error: "Child not found" },
  future_date: { status: 400, error: "Invalid request" },
  document_missing: { status: 400, error: "Invalid request" },
  invalid: { status: 400, error: "Invalid request" },
};

/**
 * FR-17: consent rows, withdrawal side effects (FR-9) and the audit row are written by one database
 * function in one transaction. Any unexpected failure (including the audit insert) -> 503, nothing saved.
 */
export async function recordConsent(input: RecordConsentInput): Promise<RecordConsentResult> {
  const p: Record<string, unknown> = {
    child_id: input.childId,
    action: input.action,
    method: input.method,
    features: input.features,
    document_ids: input.documentIds ?? [],
    locale: input.locale ?? "en",
    case_id: input.caseId ?? null,
    ip_hash: input.ipHash ?? null,
    user_agent: input.userAgent ?? null,
  };
  if (input.method === "digital") {
    p.guardian_user_id = input.guardianUserId;
    p.guardian_link_id = input.guardianLinkId;
  } else {
    p.attested_by = input.attestedBy;
    p.paper_guardian_name = input.paperGuardianName;
    p.paper_relationship = input.paperRelationship ?? null;
    p.paper_signed_on = input.paperSignedOn ?? null;
    p.paper_form_path = input.paperFormPath ?? null;
    p.paper_note = input.paperNote ?? null;
  }
  try {
    const { data, error } = await supabaseAdmin().rpc("record_consent", { p });
    if (error) {
      const code = /consent:([a-z_]+)/.exec(error.message)?.[1];
      if (code && ERRORS[code]) return { ok: false, ...ERRORS[code] };
      console.error(`record_consent failed: ${error.message}`);
      return { ok: false, status: 503, error: SAVE_FAILED };
    }
    return { ok: true, recordIds: ((data as { record_ids?: string[] } | null)?.record_ids ?? []) as string[] };
  } catch (err) {
    console.error(`record_consent failed: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, status: 503, error: SAVE_FAILED };
  }
}
