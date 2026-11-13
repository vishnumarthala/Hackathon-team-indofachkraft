// Ticket 023: document vault limits, types and API messages. Safe to import anywhere (client too).
// The same lists are the `documents` check constraints and the private `documents` bucket in
// supabase/migrations/20261113002300_documents.sql.

export const DOCUMENTS_BUCKET = "documents";
export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
/** FR-5: signed download URLs live 5 minutes and are minted only after the access check and audit row. */
export const DOWNLOAD_URL_TTL_SEC = 300;

export const DOCUMENT_MIME_TYPES = ["application/pdf", "image/jpeg", "image/png", "image/heic"] as const;
export type DocumentMime = (typeof DOCUMENT_MIME_TYPES)[number];

export const DOCUMENT_CATEGORIES = [
  "prior_report",
  "prescription",
  "school",
  "medical",
  "assessment",
  "consent_form",
  "other",
] as const;
export type DocumentCategory = (typeof DOCUMENT_CATEGORIES)[number];

/** File extensions accepted for each type (the extension must match the declared type, FR-2). */
export const EXTENSIONS: Record<DocumentMime, readonly string[]> = {
  "application/pdf": ["pdf"],
  "image/jpeg": ["jpg", "jpeg"],
  "image/png": ["png"],
  "image/heic": ["heic", "heif"],
};

/** Extension used for the stored object `<child_id>/<document_id>.<ext>`. */
export const STORED_EXTENSION: Record<DocumentMime, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/heic": "heic",
};

/** `accept` for the file input: PDF and any image so phone cameras work (NFR-2); the server checks the rest. */
export const FILE_ACCEPT = "application/pdf,image/*";

export const TOO_LARGE = "Files can be up to 20 MB";
export const UNSUPPORTED_TYPE = "Upload a PDF, JPG, PNG or HEIC file";
export const TYPE_MISMATCH = "This file does not match its type";
export const NOT_UPLOADED = "The file has not been uploaded yet";
export const DOCUMENT_NOT_FOUND = "Document not found";
export const SAVE_FAILED = "Could not save. Please try again.";
export const OPEN_FAILED = "Could not open the document. Please try again.";
export const NOT_TREATING = "This organisation is not treating your child";

export function isDocumentMime(value: unknown): value is DocumentMime {
  return typeof value === "string" && (DOCUMENT_MIME_TYPES as readonly string[]).includes(value);
}

export function isDocumentCategory(value: unknown): value is DocumentCategory {
  return typeof value === "string" && (DOCUMENT_CATEGORIES as readonly string[]).includes(value);
}

export function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot < 0 ? "" : fileName.slice(dot + 1).toLowerCase();
}

/**
 * The type to declare for a picked file. Browsers report HEIC photos as `image/heic`, `image/heif` or an empty
 * string, so the extension decides when the browser type is not one we accept.
 */
export function declaredMime(file: { name: string; type: string }): string {
  if (isDocumentMime(file.type)) return file.type;
  const ext = extensionOf(file.name);
  const byExt = DOCUMENT_MIME_TYPES.find((mime) => EXTENSIONS[mime].includes(ext));
  return byExt ?? file.type;
}

/** FR-2 checks shared by the upload dialog and the API: 415 for type/extension, 413 for size. */
export function checkFile(file: { fileName: string; mimeType: string; sizeBytes: number }): { status: 413 | 415; error: string } | null {
  if (!isDocumentMime(file.mimeType) || !EXTENSIONS[file.mimeType].includes(extensionOf(file.fileName))) {
    return { status: 415, error: UNSUPPORTED_TYPE };
  }
  if (file.sizeBytes > MAX_DOCUMENT_BYTES) return { status: 413, error: TOO_LARGE };
  return null;
}

/** Strips path parts and control characters from a client file name; keeps at most 200 characters. */
export function cleanFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[\u0000-\u001f\u007f"]/g, "").trim();
  if (cleaned.length <= 200) return cleaned;
  const ext = extensionOf(cleaned);
  return ext && ext.length < 10 ? `${cleaned.slice(0, 199 - ext.length)}.${ext}` : cleaned.slice(0, 200);
}
