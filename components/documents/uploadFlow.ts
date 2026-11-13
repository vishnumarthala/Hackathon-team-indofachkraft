// Ticket 023 FR-3: the three-step upload used by the guardian and provider dialogs (create -> PUT to the signed
// upload URL -> complete). Pure of React so the error mapping can be unit tested with fake dependencies.
import { checkFile, cleanFileName, declaredMime } from "@/lib/documents/constants";

export type UploadErrorKey =
  | "tooLarge"
  | "unsupported"
  | "mismatch"
  | "notTreating"
  | "titleRequired"
  | "categoryRequired"
  | "fileRequired"
  | "uploadFailed"
  | "saveFailed";

/** Maps the API's answers (English contract) to translated message keys. */
export function uploadErrorKey(step: "create" | "complete", status: number): UploadErrorKey {
  if (status === 413) return "tooLarge";
  if (status === 415) return "unsupported";
  if (status === 422) return step === "complete" ? "mismatch" : "notTreating";
  return step === "complete" ? "uploadFailed" : "saveFailed";
}

export type UploadDeps = {
  post(url: string, body: unknown): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }>;
  uploadToSignedUrl(path: string, token: string, file: File, contentType: string): Promise<{ error: unknown }>;
};

export type UploadRequest = {
  endpoint: string;
  file: File | null;
  title: string;
  category: string;
  extra: Record<string, unknown>;
};

export async function runDocumentUpload(req: UploadRequest, deps: UploadDeps): Promise<{ ok: true; documentId: string } | { ok: false; error: UploadErrorKey }> {
  if (!req.title.trim()) return { ok: false, error: "titleRequired" };
  if (!req.category) return { ok: false, error: "categoryRequired" };
  if (!req.file || req.file.size === 0) return { ok: false, error: "fileRequired" };
  const mimeType = declaredMime(req.file);
  const fileName = cleanFileName(req.file.name);
  const bad = checkFile({ fileName, mimeType, sizeBytes: req.file.size });
  if (bad) return { ok: false, error: bad.status === 413 ? "tooLarge" : "unsupported" };

  try {
    const created = await deps.post(req.endpoint, {
      title: req.title.trim(),
      category: req.category,
      file_name: fileName,
      mime_type: mimeType,
      size_bytes: req.file.size,
      ...req.extra,
    });
    if (!created.ok) return { ok: false, error: uploadErrorKey("create", created.status) };
    const documentId = String(created.json.document_id);
    const uploaded = await deps.uploadToSignedUrl(String(created.json.path), String(created.json.token), req.file, mimeType);
    if (uploaded.error) return { ok: false, error: "uploadFailed" };
    const completed = await deps.post(`/api/documents/${documentId}/complete`, {});
    if (!completed.ok) return { ok: false, error: uploadErrorKey("complete", completed.status) };
    return { ok: true, documentId };
  } catch {
    return { ok: false, error: "uploadFailed" };
  }
}
