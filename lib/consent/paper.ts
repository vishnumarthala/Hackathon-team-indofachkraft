// Ticket 020 FR-18a-e: paper consent recorded by the centre. Server only.
import { randomUUID } from "node:crypto";
import { supabaseAdmin } from "@/lib/db";
import { IsoDateSchema, RelationshipSchema, todayInIndia } from "@/lib/children/codes";
import { isConsentFeature, type ConsentFeature, type Relationship } from "./features";

if (typeof window !== "undefined") {
  throw new Error("lib/consent/paper.ts is server-only");
}

export const CONSENT_FORMS_BUCKET = "consent-forms";
export const MAX_SCAN_BYTES = 10 * 1024 * 1024;
export const SCAN_URL_TTL_SEC = 60;
export const ATTESTATION_TEXT = "I confirm the parent or legal guardian signed this form in person.";

const SCAN_TYPES = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png" } as const;
export type ScanType = keyof typeof SCAN_TYPES;

/** The file type from its first bytes (the browser-supplied type is not trusted). */
export function sniffScanType(bytes: Uint8Array): ScanType | null {
  const starts = (sig: number[]) => sig.every((b, i) => bytes[i] === b);
  if (starts([0x25, 0x50, 0x44, 0x46])) return "application/pdf";
  if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  return null;
}

export type PaperConsentInput = {
  features: ConsentFeature[];
  documentIds: string[];
  guardianName: string;
  relationship: Relationship;
  signedOn: string;
  scan: { bytes: Uint8Array; type: ScanType };
};

const isTrue = (value: FormDataEntryValue | null) => value === "true" || value === "on";
const all = (form: FormData, name: string) => [...form.getAll(`${name}[]`), ...form.getAll(name)].map(String);

/** FR-18c validation of the multipart body. Errors are field -> message (400). */
export async function parsePaperConsentForm(
  form: FormData,
  today: string = todayInIndia(),
): Promise<{ ok: true; data: PaperConsentInput } | { ok: false; details: Record<string, string> }> {
  const details: Record<string, string> = {};
  const features = [...new Set(all(form, "features"))];
  if (features.length === 0 || !features.every(isConsentFeature)) details.features = "Tick at least one permission";
  const documentIds = [...new Set(all(form, "consent_document_ids"))];
  if (documentIds.length === 0) details.consent_document_ids = "The printed form version is required";

  const guardianName = String(form.get("guardian_name") ?? "").trim();
  if (guardianName.length < 1 || guardianName.length > 100) details.guardian_name = "Enter the parent's name";
  const relationship = RelationshipSchema.safeParse(form.get("relationship"));
  if (!relationship.success) details.relationship = "Choose the relationship to the child";
  const signedOn = IsoDateSchema.safeParse(form.get("signed_on"));
  if (!signedOn.success) details.signed_on = "Enter the date the form was signed";
  else if (signedOn.data > today) details.signed_on = "The signing date cannot be in the future";

  if (!isTrue(form.get("attestation"))) details.attestation = "Confirm the form was signed in person";

  const file = form.get("scan");
  let scan: PaperConsentInput["scan"] | null = null;
  if (!(file instanceof File) || file.size === 0) details.scan = "Attach the signed form (PDF, JPEG or PNG)";
  else if (file.size > MAX_SCAN_BYTES) details.scan = "The file is too large (max 10 MB)";
  else {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const type = sniffScanType(bytes);
    if (!type) details.scan = "Attach the signed form (PDF, JPEG or PNG)";
    else scan = { bytes, type };
  }

  if (Object.keys(details).length > 0 || !scan || !relationship.success || !signedOn.success) {
    return { ok: false, details };
  }
  return {
    ok: true,
    data: {
      features: features as ConsentFeature[],
      documentIds,
      guardianName,
      relationship: relationship.data,
      signedOn: signedOn.data,
      scan,
    },
  };
}

export async function uploadScan(childId: string, scan: PaperConsentInput["scan"]): Promise<string> {
  const path = `${childId}/${randomUUID()}.${SCAN_TYPES[scan.type]}`;
  const { error } = await supabaseAdmin()
    .storage.from(CONSENT_FORMS_BUCKET)
    .upload(path, scan.bytes, { contentType: scan.type, upsert: false });
  if (error) throw new Error(`Could not store the scan: ${error.message}`);
  return path;
}

export async function removeScan(path: string): Promise<void> {
  const { error } = await supabaseAdmin().storage.from(CONSENT_FORMS_BUCKET).remove([path]);
  if (error) console.error(`could not remove consent scan: ${error.message}`);
}

export async function signedScanUrl(path: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin().storage.from(CONSENT_FORMS_BUCKET).createSignedUrl(path, SCAN_URL_TTL_SEC);
  return error || !data?.signedUrl ? null : data.signedUrl;
}
