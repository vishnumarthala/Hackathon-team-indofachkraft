// Credential submission and platform-admin review (ticket 028 FR-3/FR-4). Certificates live in the private
// `credentials` bucket; only platform admins get short-lived signed URLs.
import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { supabaseAdmin } from "@/lib/db";
import { drainSoon } from "@/lib/notify/outbox";
import { CREDENTIALS_BUCKET, MAX_CERTIFICATE_BYTES, type CertificateMime } from "./constants";
import { sniffType } from "./images";
import type { Result } from "./index";
import type { CredentialSubmitSchema } from "./schemas";

const EXT: Record<CertificateMime, string> = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png" };
const MIME_BY_EXT: Record<string, CertificateMime> = { pdf: "application/pdf", jpg: "image/jpeg", png: "image/png" };
export const CERTIFICATE_URL_TTL_SEC = 60;

export async function createCertificateUpload(profileId: string, mime: CertificateMime): Promise<{ path: string; token: string }> {
  const path = `${profileId}/${randomUUID()}.${EXT[mime]}`;
  const { data, error } = await supabaseAdmin().storage.from(CREDENTIALS_BUCKET).createSignedUploadUrl(path);
  if (error || !data) throw new Error(`Could not create the upload URL: ${error?.message ?? "no data"}`);
  return { path, token: data.token };
}

// The path must be one this profile was issued, and the stored bytes must really be a PDF/JPEG/PNG of the
// declared kind within the size limit (the bucket also enforces size and MIME type).
export async function checkCertificate(profileId: string, path: string): Promise<Result<null>> {
  const match = new RegExp(`^${profileId}/[0-9a-f-]{36}\\.(pdf|jpg|png)$`).exec(path);
  if (!match) return { ok: false, status: 400, error: "Upload your certificate" };
  const { data, error } = await supabaseAdmin().storage.from(CREDENTIALS_BUCKET).download(path);
  if (error || !data) return { ok: false, status: 400, error: "Upload your certificate" };
  if (data.size > MAX_CERTIFICATE_BYTES) {
    await removeCertificate(path);
    return { ok: false, status: 400, error: "File too large (max 10 MB)" };
  }
  const head = new Uint8Array(await data.slice(0, 16).arrayBuffer());
  if (sniffType(head) !== MIME_BY_EXT[match[1]]) {
    await removeCertificate(path);
    return { ok: false, status: 400, error: "Upload a PDF, JPEG or PNG file" };
  }
  return { ok: true, data: null };
}

export async function removeCertificate(path: string): Promise<void> {
  const { error } = await supabaseAdmin().storage.from(CREDENTIALS_BUCKET).remove([path]);
  if (error) console.error(`certificate cleanup failed: ${error.message}`);
}

export async function submitCredentials(
  profileId: string,
  userId: string,
  input: z.output<typeof CredentialSubmitSchema>,
): Promise<Result<{ submissionId: string }>> {
  const { data, error } = await supabaseAdmin().rpc("submit_provider_credentials", {
    p_profile: profileId,
    p_user: userId,
    p_council: input.council,
    p_state: input.state ?? null,
    p_number: input.registration_number,
    p_certificate: input.certificate_path,
  });
  if (error) throw new Error(`Could not submit credentials: ${error.message}`);
  const outcome = data as { result: string; submission_id?: string; replaced_certificate?: string | null };
  if (outcome.result === "not_found") return { ok: false, status: 404, error: "Profile not found" };
  if (outcome.result === "suspended") {
    return { ok: false, status: 409, error: "Your profile is suspended. Contact DoctorNearMe support." };
  }
  if (outcome.replaced_certificate) await removeCertificate(outcome.replaced_certificate);
  return { ok: true, data: { submissionId: outcome.submission_id as string } };
}

export type PendingSubmission = {
  id: string;
  council: string;
  state: string | null;
  registration_number: string;
  certificate_path: string | null;
  created_at: string;
  profile: { id: string; slug: string; display_name: string; provider_type: string; verification_status: string; claimed: boolean; is_synthetic: boolean };
};

export async function listPendingSubmissions(): Promise<PendingSubmission[]> {
  const { data, error } = await supabaseAdmin()
    .from("credential_submissions")
    .select(
      "id, council, state, registration_number, certificate_path, created_at, " +
        "provider_profiles(id, slug, display_name, provider_type, verification_status, claimed, is_synthetic)",
    )
    .eq("status", "submitted")
    .order("created_at");
  if (error) throw new Error(`Could not load submissions: ${error.message}`);
  type Row = Omit<PendingSubmission, "profile"> & { provider_profiles: PendingSubmission["profile"] };
  return ((data ?? []) as unknown as Row[]).map(({ provider_profiles, ...row }) => ({ ...row, profile: provider_profiles }));
}

export async function reviewSubmission(
  submissionId: string,
  adminId: string,
  action: "approve" | "reject",
  note: string | null,
): Promise<Result<{ profileId: string }>> {
  const { data, error } = await supabaseAdmin().rpc("review_credential_submission", {
    p_submission: submissionId,
    p_admin: adminId,
    p_action: action,
    p_note: note,
  });
  if (error) throw new Error(`Could not review submission: ${error.message}`);
  const outcome = data as { result: string; profile_id?: string };
  if (outcome.result === "note_required") {
    return {
      ok: false,
      status: 400,
      error: action === "reject" ? "A note is required to reject" : "Say what you checked before approving",
    };
  }
  if (outcome.result === "suspended") return { ok: false, status: 409, error: "This profile is suspended" };
  if (outcome.result !== "approved" && outcome.result !== "rejected") {
    return { ok: false, status: 404, error: "Submission not found" };
  }
  const profileId = outcome.profile_id as string;
  // 032: the decision's outbox event (provider.verified / provider.rejected) was written by a trigger in the same
  // transaction; deliver it right after the response.
  drainSoon();
  return { ok: true, data: { profileId } };
}

export async function suspendProfile(profileId: string, adminId: string, note: string): Promise<Result<null>> {
  const { data, error } = await supabaseAdmin().rpc("suspend_provider_profile", {
    p_profile: profileId,
    p_admin: adminId,
    p_note: note,
  });
  if (error) throw new Error(`Could not suspend profile: ${error.message}`);
  if (data === "not_found") return { ok: false, status: 404, error: "Profile not found" };
  if (data === "not_verified") return { ok: false, status: 409, error: "Only verified profiles can be suspended" };
  if (data === "note_required") return { ok: false, status: 400, error: "A note is required to suspend" };
  drainSoon(); // 032: provider.suspended was enqueued by a trigger in the suspension transaction.
  return { ok: true, data: null };
}

export async function certificateSignedUrl(submissionId: string): Promise<string | null> {
  const db = supabaseAdmin();
  const { data, error } = await db.from("credential_submissions").select("certificate_path").eq("id", submissionId).maybeSingle();
  if (error) throw new Error(`Could not load submission: ${error.message}`);
  const path = (data as { certificate_path: string | null } | null)?.certificate_path;
  if (!path) return null;
  const signed = await db.storage.from(CREDENTIALS_BUCKET).createSignedUrl(path, CERTIFICATE_URL_TTL_SEC, { download: true });
  if (signed.error || !signed.data) throw new Error(`Could not sign certificate URL: ${signed.error?.message ?? "no data"}`);
  return signed.data.signedUrl;
}

export type AdminProfileRow = {
  id: string;
  slug: string;
  display_name: string;
  provider_type: string;
  verification_status: string;
  listed: boolean;
  claimed: boolean;
  is_synthetic: boolean;
  created_at: string;
};

export async function listProfilesForAdmin(limit = 200): Promise<AdminProfileRow[]> {
  const { data, error } = await supabaseAdmin()
    .from("provider_profiles")
    .select("id, slug, display_name, provider_type, verification_status, listed, claimed, is_synthetic, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`Could not load profiles: ${error.message}`);
  return (data ?? []) as AdminProfileRow[];
}
