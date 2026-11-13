// Ticket 023 test helpers: synthetic files (never real documents) and the three-step upload through the routes.
import type { Sql } from "postgres";
import { ctx, post, type TestUser } from "./world";

type Db = ReturnType<typeof import("@/lib/db").supabaseAdmin>;

export const PDF_BYTES = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n");
export const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);
export const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);
/** ISO BMFF `ftyp` box: size 0x18, major brand `heic`, compatible `mif1`, `heic`. */
export const HEIC_BYTES = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from("ftypheic"),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from("mif1heic"),
  Buffer.alloc(16),
]);

export type UploadBody = {
  title: string;
  category: string;
  file_name: string;
  mime_type: string;
  size_bytes?: number;
  share_with_org_ids?: string[];
  visible_to_guardian?: boolean;
};

export function documentRoutes() {
  return {
    family: () => import("@/app/api/family/children/[id]/documents/route"),
    familyShares: () => import("@/app/api/family/children/[id]/documents/[docId]/shares/route"),
    familyShare: () => import("@/app/api/family/children/[id]/documents/[docId]/shares/[orgId]/route"),
    kase: () => import("@/app/api/cases/[id]/documents/route"),
    doc: () => import("@/app/api/documents/[docId]/route"),
    complete: () => import("@/app/api/documents/[docId]/complete/route"),
    download: () => import("@/app/api/documents/[docId]/download/route"),
  };
}

/**
 * Upload helper: step 1 through the guardian or provider route as `user`, the bytes PUT to the signed upload
 * URL, then step 2 (`complete`). `as` sets the mocked session.
 */
export function createUploader(db: Db, as: (u: TestUser | null) => void) {
  const routes = documentRoutes();

  async function start(user: TestUser, target: { childId: string } | { caseId: string }, body: UploadBody, size: number) {
    as(user);
    const payload = { size_bytes: size, ...body };
    return "childId" in target
      ? (await routes.family()).POST(post("http://localhost/x", payload), ctx({ id: target.childId }))
      : (await routes.kase()).POST(post("http://localhost/x", payload), ctx({ id: target.caseId }));
  }

  async function put(path: string, token: string, bytes: Buffer, contentType: string) {
    return db.storage.from("documents").uploadToSignedUrl(path, token, bytes, { contentType });
  }

  async function complete(user: TestUser, documentId: string) {
    as(user);
    return (await routes.complete()).POST(post("http://localhost/x"), ctx({ docId: documentId }));
  }

  /** Full flow; returns the document id and the completion response. Throws if step 1 or the PUT fails. */
  async function upload(
    user: TestUser,
    target: { childId: string } | { caseId: string },
    body: UploadBody,
    bytes: Buffer,
  ): Promise<{ id: string; path: string; completed: Response }> {
    const res = await start(user, target, body, bytes.length);
    if (res.status !== 201) throw new Error(`upload start failed: ${res.status} ${await res.text()}`);
    const ticket = (await res.json()) as { document_id: string; token: string; path: string; signed_upload_url: string };
    const putResult = await put(ticket.path, ticket.token, bytes, body.mime_type);
    if (putResult.error) throw new Error(`PUT failed: ${putResult.error.message}`);
    const completed = await complete(user, ticket.document_id);
    return { id: ticket.document_id, path: ticket.path, completed };
  }

  return { start, put, complete, upload };
}

export async function objectExists(db: Db, path: string): Promise<boolean> {
  const { data, error } = await db.storage.from("documents").exists(path);
  return !error && data === true;
}

/** Removes every object stored for the given children (tests only; rows go with the children). */
export async function purgeDocumentObjects(sql: Sql, db: Db, childIds: string[]) {
  if (childIds.length === 0) return;
  const rows = await sql<{ storage_path: string }[]>`select storage_path from documents where child_id in ${sql(childIds)}`;
  const paths = rows.map((r) => r.storage_path);
  for (let i = 0; i < paths.length; i += 100) await db.storage.from("documents").remove(paths.slice(i, i + 100));
}
