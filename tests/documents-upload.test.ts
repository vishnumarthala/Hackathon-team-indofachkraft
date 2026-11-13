// Ticket 023 FR-2/FR-3/FR-9: upload validation (type, extension, size, magic bytes), the two-step upload
// through the guardian and provider routes, completion (sha256, audit, notification), and the private bucket.
// The database part needs the local Supabase stack (DATABASE_URL). Synthetic files only; everything is removed.
import { createHash, randomUUID } from "node:crypto";
import { loadEnvConfig } from "@next/env";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runDocumentUpload, uploadErrorKey, type UploadDeps } from "@/components/documents/uploadFlow";
import { checkFile, cleanFileName, declaredMime, MAX_DOCUMENT_BYTES } from "@/lib/documents/constants";
import { sniffDocumentType } from "@/lib/documents/magic";
import { GuardianUploadSchema, ProviderUploadSchema } from "@/lib/documents/schemas";
import { createUploader, HEIC_BYTES, JPEG_BYTES, objectExists, PDF_BYTES, PNG_BYTES, purgeDocumentObjects } from "./helpers/documents";
import { createWorld, type TestUser } from "./helpers/world";

loadEnvConfig(process.cwd(), false, { info: () => {}, error: () => {} });
const enabled = Boolean(process.env.DATABASE_URL) && process.env.SKIP_DB_TESTS !== "1";

const session = vi.hoisted(() => ({ user: null as null | { id: string; email: string } }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getAuthenticatedUser: vi.fn(async () => session.user) };
});

const notify = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock("@/lib/notify/topics", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/notify/topics")>();
  return { ...actual, notifyLater: vi.fn(async (...args: unknown[]) => void notify.calls.push(args)) };
});

describe("file checks (FR-2)", () => {
  it("sniffs PDF, JPEG, PNG and HEIC by their first bytes; anything else is null", () => {
    expect(sniffDocumentType(PDF_BYTES)).toBe("application/pdf");
    expect(sniffDocumentType(PNG_BYTES)).toBe("image/png");
    expect(sniffDocumentType(JPEG_BYTES)).toBe("image/jpeg");
    expect(sniffDocumentType(HEIC_BYTES)).toBe("image/heic");
    const generic = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypmif1"), Buffer.alloc(4), Buffer.from("mif1heic")]);
    expect(sniffDocumentType(generic)).toBe("image/heic");
    const avif = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypavif"), Buffer.alloc(4), Buffer.from("mif1avif")]);
    expect(sniffDocumentType(avif)).toBeNull();
    expect(sniffDocumentType(Buffer.from("hello, plain text"))).toBeNull();
    expect(sniffDocumentType(new Uint8Array())).toBeNull();
  });

  it("type and extension must match (415); more than 20 MB is 413", () => {
    const ok = { fileName: "letter.pdf", mimeType: "application/pdf", sizeBytes: 1000 };
    expect(checkFile(ok)).toBeNull();
    expect(checkFile({ ...ok, fileName: "photo.HEIC", mimeType: "image/heic" })).toBeNull();
    expect(checkFile({ ...ok, fileName: "photo.jpeg", mimeType: "image/jpeg" })).toBeNull();
    expect(checkFile({ ...ok, fileName: "notes.txt", mimeType: "text/plain" })).toEqual({ status: 415, error: "Upload a PDF, JPG, PNG or HEIC file" });
    expect(checkFile({ ...ok, fileName: "letter.png" })).toEqual({ status: 415, error: "Upload a PDF, JPG, PNG or HEIC file" });
    expect(checkFile({ ...ok, fileName: "letter" })?.status).toBe(415);
    expect(checkFile({ ...ok, sizeBytes: MAX_DOCUMENT_BYTES })).toBeNull();
    expect(checkFile({ ...ok, sizeBytes: MAX_DOCUMENT_BYTES + 1 })).toEqual({ status: 413, error: "Files can be up to 20 MB" });
  });

  it("declares HEIC from the extension when the browser gives no or another type; cleans file names", () => {
    expect(declaredMime({ name: "IMG_0001.HEIC", type: "" })).toBe("image/heic");
    expect(declaredMime({ name: "IMG_0001.heif", type: "image/heif" })).toBe("image/heic");
    expect(declaredMime({ name: "scan.pdf", type: "application/pdf" })).toBe("application/pdf");
    expect(declaredMime({ name: "notes.txt", type: "text/plain" })).toBe("text/plain");
    expect(cleanFileName("C:\\Users\\x\\report\u0007.pdf")).toBe("report.pdf");
    expect(cleanFileName("../../etc/passwd")).toBe("passwd");
    const long = cleanFileName(`${"a".repeat(300)}.pdf`);
    expect(long).toHaveLength(200);
    expect(long.endsWith(".pdf")).toBe(true);
  });

  it("validates upload bodies", () => {
    const base = { title: " School letter ", category: "school", file_name: "a.pdf", mime_type: "application/pdf", size_bytes: 10 };
    expect(GuardianUploadSchema.parse(base)).toMatchObject({ title: "School letter", share_with_org_ids: [] });
    expect(GuardianUploadSchema.safeParse({ ...base, title: "" }).success).toBe(false);
    expect(GuardianUploadSchema.safeParse({ ...base, title: "x".repeat(121) }).success).toBe(false);
    expect(GuardianUploadSchema.safeParse({ ...base, category: "x-ray" }).success).toBe(false);
    expect(GuardianUploadSchema.safeParse({ ...base, size_bytes: 0 }).success).toBe(false);
    expect(GuardianUploadSchema.safeParse({ ...base, share_with_org_ids: ["nope"] }).success).toBe(false);
    expect(ProviderUploadSchema.parse(base).visible_to_guardian).toBe(true);
    expect(ProviderUploadSchema.parse({ ...base, visible_to_guardian: false }).visible_to_guardian).toBe(false);
  });
});

describe("upload dialog flow", () => {
  const file = (name: string, type: string, size = 10) => new File([new Uint8Array(size)], name, { type });
  const fake = (responses: { ok: boolean; status: number; json?: Record<string, unknown> }[], putError: unknown = null) => {
    const calls: string[] = [];
    const deps: UploadDeps = {
      async post(url) {
        calls.push(url);
        const next = responses.shift()!;
        return { ok: next.ok, status: next.status, json: next.json ?? {} };
      },
      async uploadToSignedUrl() {
        calls.push("PUT");
        return { error: putError };
      },
    };
    return { deps, calls };
  };
  const req = (f: File | null, extra = {}) => ({ endpoint: "/api/x", file: f, title: "Letter", category: "school", extra });

  it("maps API statuses to translated keys", () => {
    expect(uploadErrorKey("create", 413)).toBe("tooLarge");
    expect(uploadErrorKey("create", 415)).toBe("unsupported");
    expect(uploadErrorKey("create", 422)).toBe("notTreating");
    expect(uploadErrorKey("complete", 422)).toBe("mismatch");
    expect(uploadErrorKey("complete", 503)).toBe("uploadFailed");
    expect(uploadErrorKey("create", 503)).toBe("saveFailed");
  });

  it("checks the file before any request, then create -> PUT -> complete", async () => {
    const tooBig = fake([]);
    expect(await runDocumentUpload(req(file("a.pdf", "application/pdf", MAX_DOCUMENT_BYTES + 1)), tooBig.deps)).toEqual({ ok: false, error: "tooLarge" });
    expect(await runDocumentUpload(req(file("a.txt", "text/plain")), tooBig.deps)).toEqual({ ok: false, error: "unsupported" });
    expect(await runDocumentUpload(req(null), tooBig.deps)).toEqual({ ok: false, error: "fileRequired" });
    expect(tooBig.calls).toEqual([]);

    const good = fake([{ ok: true, status: 201, json: { document_id: "d1", path: "c/d1.heic", token: "t" } }, { ok: true, status: 200 }]);
    expect(await runDocumentUpload(req(file("IMG.HEIC", "")), good.deps)).toEqual({ ok: true, documentId: "d1" });
    expect(good.calls).toEqual(["/api/x", "PUT", "/api/documents/d1/complete"]);

    const mismatch = fake([{ ok: true, status: 201, json: { document_id: "d2", path: "p", token: "t" } }, { ok: false, status: 422 }]);
    expect(await runDocumentUpload(req(file("a.pdf", "application/pdf")), mismatch.deps)).toEqual({ ok: false, error: "mismatch" });
    const putFails = fake([{ ok: true, status: 201, json: { document_id: "d3", path: "p", token: "t" } }], { message: "x" });
    expect(await runDocumentUpload(req(file("a.pdf", "application/pdf")), putFails.deps)).toEqual({ ok: false, error: "uploadFailed" });
  });
});

describe.skipIf(!enabled)("document uploads (database)", { timeout: 120_000 }, () => {
  let sql: Sql;
  let db: ReturnType<typeof import("@/lib/db").supabaseAdmin>;
  let world: ReturnType<typeof createWorld>;
  let up: ReturnType<typeof createUploader>;
  let ownerA: TestUser, memberA: TestUser, assignedA: TestUser, ownerB: TestUser, ownerC: TestUser, guardian: TestUser, stranger: TestUser;
  let orgA: string, orgB: string, orgC: string, childId: string, caseA: string;

  const as = (u: TestUser | null) => {
    session.user = u;
  };
  const pdf = { title: "t023 School letter (synthetic)", category: "school", file_name: "letter.pdf", mime_type: "application/pdf" };

  beforeAll(async () => {
    sql = postgres(process.env.DATABASE_URL as string, { max: 4, prepare: false, onnotice: () => {} });
    db = (await import("@/lib/db")).supabaseAdmin();
    world = createWorld(sql, db, "t023u");
    up = createUploader(db, as);
    ownerA = await world.user("owner-a", "provider");
    memberA = await world.user("member-a", "provider");
    assignedA = await world.user("assigned-a", "provider");
    ownerB = await world.user("owner-b", "provider");
    ownerC = await world.user("owner-c", "provider");
    guardian = await world.user("guardian", "guardian");
    stranger = await world.user("stranger", "guardian");
    orgA = await world.org(ownerA, "Centre A");
    orgB = await world.org(ownerB, "Centre B");
    orgC = await world.org(ownerC, "Centre C");
    await world.member(orgA, memberA);
    await world.member(orgA, assignedA);
    ({ caseId: caseA, childId } = await world.kase(orgA));
    await world.kase(orgB, { childId });
    await world.kase(orgC);
    await world.link(childId, guardian);
    await sql`insert into case_assignments (case_id, user_id) values (${caseA}, ${assignedA.id})`;
  });

  afterAll(async () => {
    if (childId) await purgeDocumentObjects(sql, db, [childId]);
    await world?.cleanup();
    await sql?.end({ timeout: 5 });
  });

  beforeEach(() => {
    as(null);
    notify.calls = [];
  });

  it("the bucket is private with a 20 MB limit and the four types", async () => {
    const [bucket] = await sql<{ public: boolean; file_size_limit: number; allowed_mime_types: string[] }[]>`
      select public, file_size_limit::int as file_size_limit, allowed_mime_types from storage.buckets where id = 'documents'`;
    expect(bucket).toEqual({
      public: false,
      file_size_limit: 20971520,
      allowed_mime_types: ["application/pdf", "image/jpeg", "image/png", "image/heic"],
    });
  });

  it("E-1.1 guardian upload: 201 ticket -> PUT -> complete (ready, sha256, audit document.uploaded, share recorded)", async () => {
    const res = await up.start(guardian, { childId }, { ...pdf, share_with_org_ids: [orgA] }, PDF_BYTES.length);
    expect(res.status).toBe(201);
    const ticket = await res.json();
    expect(Object.keys(ticket).sort()).toEqual(["document_id", "path", "signed_upload_url", "token"]);
    expect(ticket.path).toBe(`${childId}/${ticket.document_id}.pdf`);
    expect(ticket.signed_upload_url).toContain("/object/upload/sign/documents/");
    const [pending] = await sql<{ status: string; uploader_kind: string; visible_to_guardian: boolean }[]>`
      select status, uploader_kind, visible_to_guardian from documents where id = ${ticket.document_id}`;
    expect(pending).toEqual({ status: "pending", uploader_kind: "guardian", visible_to_guardian: true });

    // Before the bytes arrive: 409, still pending, never listed.
    expect((await up.complete(guardian, ticket.document_id)).status).toBe(409);
    const { listGuardianDocuments } = await import("@/lib/documents/store");
    expect((await listGuardianDocuments([childId])).map((d) => d.id)).not.toContain(ticket.document_id);

    expect((await up.put(ticket.path, ticket.token, PDF_BYTES, "application/pdf")).error).toBeNull();
    // Only the uploader completes.
    expect((await up.complete(stranger, ticket.document_id)).status).toBe(404);
    expect((await up.complete(ownerA, ticket.document_id)).status).toBe(404);
    const done = await up.complete(guardian, ticket.document_id);
    expect(done.status).toBe(200);
    const { document } = await done.json();
    expect(document).toMatchObject({ id: ticket.document_id, status: "ready", size_bytes: PDF_BYTES.length, uploaded_by_me: true });
    expect(document.sha256).toBe(createHash("sha256").update(PDF_BYTES).digest("hex"));
    expect(document).not.toHaveProperty("storage_path");
    expect((await up.complete(guardian, ticket.document_id)).status).toBe(404);

    const [audit] = await sql<{ actor: string; actor_user_id: string; details: Record<string, unknown> }[]>`
      select actor, actor_user_id, details from audit_events where action = 'document.uploaded' and entity_id = ${ticket.document_id}`;
    expect(audit).toMatchObject({ actor: "parent", actor_user_id: guardian.id });
    expect(audit.details).toMatchObject({ child_id: childId, category: "school", shared_with_org_ids: [orgA] });
    expect(JSON.stringify(audit.details)).not.toContain("School letter");
    const shares = await sql`select org_id from document_org_shares where document_id = ${ticket.document_id} and revoked_at is null`;
    expect(shares.map((s) => s.org_id)).toEqual([orgA]);
    expect(notify.calls).toEqual([]);
  });

  it("E-3 validation: 21 MB -> 413, .txt -> 415, PDF-named PNG bytes -> 422 and no object left", async () => {
    const big = await up.start(guardian, { childId }, pdf, 21 * 1024 * 1024);
    expect(big.status).toBe(413);
    expect(await big.json()).toEqual({ error: "Files can be up to 20 MB" });
    const txt = await up.start(guardian, { childId }, { ...pdf, file_name: "notes.txt", mime_type: "text/plain" }, 10);
    expect(txt.status).toBe(415);
    expect(await txt.json()).toEqual({ error: "Upload a PDF, JPG, PNG or HEIC file" });
    const renamed = await up.start(guardian, { childId }, { ...pdf, file_name: "letter.png" }, 10);
    expect(renamed.status).toBe(415);
    const before = await sql`select 1 from documents where child_id = ${childId} and file_name in ('notes.txt', 'letter.png')`;
    expect(before).toHaveLength(0);

    const { id, path, completed } = await up.upload(guardian, { childId }, { ...pdf, file_name: "fake.pdf" }, PNG_BYTES);
    expect(completed.status).toBe(422);
    expect(await completed.json()).toEqual({ error: "This file does not match its type" });
    const [row] = await sql<{ status: string; deleted_by: string }[]>`select status, deleted_by from documents where id = ${id}`;
    expect(row).toEqual({ status: "deleted", deleted_by: guardian.id });
    expect(await objectExists(db, path)).toBe(false);
    const [rejected] = await sql<{ details: { reason: string } }[]>`
      select details from audit_events where action = 'document.rejected' and entity_id = ${id}`;
    expect(rejected.details.reason).toBe("type_mismatch");
  });

  it("the bucket itself refuses more than 20 MB even with a valid upload ticket", async () => {
    const res = await up.start(guardian, { childId }, pdf, 1000);
    const ticket = await res.json();
    const tooBig = Buffer.concat([PDF_BYTES, Buffer.alloc(MAX_DOCUMENT_BYTES)]);
    const put = await up.put(ticket.path, ticket.token, tooBig, "application/pdf");
    expect(put.error).not.toBeNull();
    expect(await objectExists(db, ticket.path)).toBe(false);
  });

  it("guardian: share_with_org_ids must treat the child (422, nothing saved); other families 404; providers 403", async () => {
    const res = await up.start(guardian, { childId }, { ...pdf, title: "t023 no-case", share_with_org_ids: [orgA, orgC] }, 10);
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "This organisation is not treating your child" });
    expect(await sql`select 1 from documents where title = 't023 no-case'`).toHaveLength(0);
    expect((await up.start(stranger, { childId }, pdf, 10)).status).toBe(404);
    expect((await up.start(ownerA, { childId }, pdf, 10)).status).toBe(403);
    as(null);
    const { POST } = await import("@/app/api/family/children/[id]/documents/route");
    expect((await POST(new Request("http://localhost/x", { method: "POST", body: "{}" }), { params: Promise.resolve({ id: childId }) })).status).toBe(401);
  });

  it("provider upload: case access required (unassigned member / other org 404, guardian 403); org = case org", async () => {
    const png = { title: "t023 OT note (synthetic)", category: "assessment", file_name: "note.png", mime_type: "image/png" };
    expect((await up.start(memberA, { caseId: caseA }, png, 10)).status).toBe(404);
    expect((await up.start(ownerB, { caseId: caseA }, png, 10)).status).toBe(404);
    expect((await up.start(guardian, { caseId: caseA }, png, 10)).status).toBe(403);

    const hidden = await up.upload(assignedA, { caseId: caseA }, { ...png, visible_to_guardian: false }, PNG_BYTES);
    expect(hidden.completed.status).toBe(200);
    expect(notify.calls).toEqual([]);
    const [row] = await sql<{ org_id: string; case_id: string; child_id: string; uploader_kind: string; visible_to_guardian: boolean }[]>`
      select org_id, case_id, child_id, uploader_kind, visible_to_guardian from documents where id = ${hidden.id}`;
    expect(row).toEqual({ org_id: orgA, case_id: caseA, child_id: childId, uploader_kind: "provider", visible_to_guardian: false });

    // FR-9: a guardian-visible provider upload emits document.shared_with_guardian with ids only.
    const visible = await up.upload(ownerA, { caseId: caseA }, { ...png, file_name: "photo.heic", mime_type: "image/heic" }, HEIC_BYTES);
    expect(visible.completed.status).toBe(200);
    expect(notify.calls).toEqual([["document.shared_with_guardian", { document_id: visible.id, child_id: childId, org_id: orgA }]]);
    const [audit] = await sql<{ case_id: string; actor: string }[]>`
      select case_id, actor from audit_events where action = 'document.uploaded' and entity_id = ${visible.id}`;
    expect(audit).toEqual({ case_id: caseA, actor: "therapist" });
  });

  it("strict audit: if document.uploaded cannot be written the upload stays pending (503)", async () => {
    const fn = `t023_fail_audit_${randomUUID().slice(0, 8)}`;
    const res = await up.start(guardian, { childId }, pdf, PDF_BYTES.length);
    const ticket = await res.json();
    await up.put(ticket.path, ticket.token, PDF_BYTES, "application/pdf");
    await sql.unsafe(`
      create function public.${fn}() returns trigger language plpgsql as $f$
      begin raise exception 'forced audit failure (test)'; end $f$;
      create trigger ${fn} before insert on public.audit_events for each row
      when (new.action = 'document.uploaded' and new.entity_id = '${ticket.document_id}') execute function public.${fn}();`);
    try {
      const failed = await up.complete(guardian, ticket.document_id);
      expect(failed.status).toBe(503);
    } finally {
      await sql.unsafe(`drop trigger if exists ${fn} on public.audit_events; drop function if exists public.${fn}();`);
    }
    const [row] = await sql<{ status: string }[]>`select status from documents where id = ${ticket.document_id}`;
    expect(row.status).toBe("pending");
    expect((await up.complete(guardian, ticket.document_id)).status).toBe(200);
  });

  it("a guardian who lost the link cannot complete a pending upload", async () => {
    const res = await up.start(guardian, { childId }, pdf, PDF_BYTES.length);
    const ticket = await res.json();
    await up.put(ticket.path, ticket.token, PDF_BYTES, "application/pdf");
    await sql`update guardian_links set status = 'revoked', revoked_at = now() where child_id = ${childId} and user_id = ${guardian.id}`;
    try {
      expect((await up.complete(guardian, ticket.document_id)).status).toBe(404);
    } finally {
      await sql`update guardian_links set status = 'active', revoked_at = null where child_id = ${childId} and user_id = ${guardian.id}`;
    }
  });
});
