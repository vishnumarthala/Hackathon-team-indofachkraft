// Ticket 023 FR-4/FR-5/FR-6/FR-7/FR-8/NFR-1: who may read, download, change and delete a document. The FR-4
// matrix (guardian linked/unlinked; provider own case / unassigned / shared org / grant / revoked grant / other
// org; visible_to_guardian true/false; deleted), downloads (302 to a 300 s signed URL, strict audit), deletes,
// guardian shares, the `documents` share loader, RLS and the private bucket. Needs the local Supabase stack
// (DATABASE_URL). Synthetic data only; everything is removed afterwards.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { loadEnvConfig } from "@next/env";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { documentActionErrorKey } from "@/components/documents/DocumentList";
import { createUploader, documentEvents, documentRoutes, objectExists, PDF_BYTES, PNG_BYTES, purgeDocumentObjects } from "./helpers/documents";
import { createWorld, ctx, post, type TestUser } from "./helpers/world";

loadEnvConfig(process.cwd(), false, { info: () => {}, error: () => {} });
const enabled = Boolean(process.env.DATABASE_URL) && process.env.SKIP_DB_TESTS !== "1";

const session = vi.hoisted(() => ({ user: null as null | { id: string; email: string } }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getAuthenticatedUser: vi.fn(async () => session.user) };
});

const ROOT = process.cwd();
function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...routeFiles(full));
    else if (entry === "route.ts") out.push(full);
  }
  return out;
}

describe("every /api/documents handler passes the document gate first (static scan)", () => {
  const files = routeFiles(path.join(ROOT, "app/api/documents"));
  it("finds the routes", () => {
    expect(files.map((f) => path.relative(ROOT, f)).sort()).toEqual([
      "app/api/documents/[docId]/complete/route.ts",
      "app/api/documents/[docId]/download/route.ts",
      "app/api/documents/[docId]/route.ts",
    ]);
  });
  it.each(files.map((f) => [path.relative(ROOT, f)]))("%s", (rel) => {
    const source = readFileSync(path.join(ROOT, rel), "utf8");
    const handlers = [...source.matchAll(/export async function (GET|POST|PATCH|DELETE)\([^)]*\)[^{]*\{\s*([^\n]*)\n\s*([^\n]*)\n\s*([^\n]*)/g)];
    expect(handlers.length).toBeGreaterThan(0);
    for (const [, method, first, second, third] of handlers) {
      expect(first, `${rel} ${method}`).toMatch(/await params/);
      expect(second, `${rel} ${method}`).toMatch(/await (requireDocumentAccess|requirePendingUpload)\(docId\)/);
      expect(third, `${rel} ${method}`).toMatch(/instanceof Response\) return/);
    }
  });

  it("maps action statuses to translated keys", () => {
    expect(documentActionErrorKey(403)).toBe("forbidden");
    expect(documentActionErrorKey(422)).toBe("notTreating");
    expect(documentActionErrorKey(503)).toBe("saveFailed");
  });
});

describe.skipIf(!enabled)("document access (database)", { timeout: 120_000 }, () => {
  let sql: Sql;
  let db: ReturnType<typeof import("@/lib/db").supabaseAdmin>;
  let world: ReturnType<typeof createWorld>;
  let up: ReturnType<typeof createUploader>;
  let access: typeof import("@/lib/documents/access");
  let store: typeof import("@/lib/documents/store");
  let loader: typeof import("@/lib/sharing/loaders/documents").documentsLoader;
  const routes = documentRoutes();

  let ownerA: TestUser, assignedA: TestUser, unassignedA: TestUser, ownerB: TestUser, memberB: TestUser, ownerC: TestUser;
  let guardianA: TestUser, guardianA2: TestUser, guardianB: TestUser;
  let orgA: string, orgB: string, orgC: string, childId: string, otherChild: string, caseA: string, caseB: string;
  // G1 guardian upload shared with org A; G2 guardian upload not shared; P1 provider upload visible; P2 hidden.
  let G1: string, G2: string, P1: string, P2: string, P1path: string, G2path: string;

  const as = (u: TestUser | null) => {
    session.user = u;
  };
  const pathOf = async (user: TestUser, id: string) => (await access.getDocumentAccess(user.id, id))?.path ?? null;

  async function download(user: TestUser | null, id: string) {
    as(user);
    return (await routes.download()).GET(post("http://localhost/x", undefined, "GET"), ctx({ docId: id }));
  }
  async function meta(user: TestUser, id: string) {
    as(user);
    return (await routes.doc()).GET(post("http://localhost/x", undefined, "GET"), ctx({ docId: id }));
  }
  async function remove(user: TestUser, id: string) {
    as(user);
    return (await routes.doc()).DELETE(post("http://localhost/x", undefined, "DELETE"), ctx({ docId: id }));
  }
  async function patch(user: TestUser, id: string, body: unknown) {
    as(user);
    return (await routes.doc()).PATCH(post("http://localhost/x", body, "PATCH"), ctx({ docId: id }));
  }
  async function grant(scopes: string[]) {
    as(guardianA);
    const { POST } = await import("@/app/api/family/children/[id]/sharing-grants/route");
    const res = await POST(post("http://localhost/x", { source_org_id: orgA, grantee_org_id: orgB, scopes }), ctx({ id: childId }));
    expect(res.status).toBe(201);
    return (await res.json()).grant.id as string;
  }
  async function revokeGrant(id: string) {
    as(guardianA);
    const { POST } = await import("@/app/api/family/children/[id]/sharing-grants/[grantId]/revoke/route");
    expect((await POST(post("http://localhost/x"), ctx({ id: childId, grantId: id }))).status).toBe(200);
  }

  beforeAll(async () => {
    sql = postgres(process.env.DATABASE_URL as string, { max: 4, prepare: false, onnotice: () => {} });
    db = (await import("@/lib/db")).supabaseAdmin();
    access = await import("@/lib/documents/access");
    store = await import("@/lib/documents/store");
    loader = (await import("@/lib/sharing/loaders/documents")).documentsLoader;
    world = createWorld(sql, db, "t023a");
    up = createUploader(db, as);
    ownerA = await world.user("owner-a", "provider");
    assignedA = await world.user("assigned-a", "provider");
    unassignedA = await world.user("unassigned-a", "provider");
    ownerB = await world.user("owner-b", "provider");
    memberB = await world.user("member-b", "provider");
    ownerC = await world.user("owner-c", "provider");
    guardianA = await world.user("guardian-a", "guardian", { phoneVerified: true });
    guardianA2 = await world.user("guardian-a2", "guardian");
    guardianB = await world.user("guardian-b", "guardian");
    orgA = await world.org(ownerA, "Centre A");
    orgB = await world.org(ownerB, "Centre B");
    orgC = await world.org(ownerC, "Centre C");
    await world.member(orgA, assignedA);
    await world.member(orgA, unassignedA);
    await world.member(orgB, memberB);
    ({ caseId: caseA, childId } = await world.kase(orgA));
    ({ caseId: caseB } = await world.kase(orgB, { childId }));
    ({ childId: otherChild } = await world.kase(orgC));
    await world.link(childId, guardianA);
    await world.link(childId, guardianA2, "father");
    await world.link(otherChild, guardianB);
    await sql`insert into case_assignments (case_id, user_id) values (${caseA}, ${assignedA.id})`;

    const pdf = { category: "school", file_name: "letter.pdf", mime_type: "application/pdf" };
    const png = { category: "assessment", file_name: "chart.png", mime_type: "image/png" };
    const g1 = await up.upload(guardianA, { childId }, { ...pdf, title: "t023 School letter G1", share_with_org_ids: [orgA] }, PDF_BYTES);
    const g2 = await up.upload(guardianA, { childId }, { ...pdf, title: "t023 Prior report G2", category: "prior_report" }, PDF_BYTES);
    const p1 = await up.upload(assignedA, { caseId: caseA }, { ...png, title: "t023 OT chart P1", visible_to_guardian: true }, PNG_BYTES);
    const p2 = await up.upload(assignedA, { caseId: caseA }, { ...png, title: "t023 Internal note P2", visible_to_guardian: false }, PNG_BYTES);
    for (const u of [g1, g2, p1, p2]) expect(u.completed.status).toBe(200);
    ({ id: G1 } = g1);
    ({ id: G2, path: G2path } = g2);
    ({ id: P1, path: P1path } = p1);
    ({ id: P2 } = p2);
  });

  afterAll(async () => {
    if (childId) await purgeDocumentObjects(sql, db, [childId]);
    await world?.cleanup();
    await sql?.end({ timeout: 5 });
  });

  beforeEach(() => {
    as(null);
  });

  it("FR-4 matrix without grants", async () => {
    const expected: [string, TestUser, (string | null)[]][] = [
      // who, user, [G1, G2, P1, P2]
      ["linked guardian", guardianA, ["guardian", "guardian", "guardian", null]],
      ["second linked guardian", guardianA2, ["guardian", "guardian", "guardian", null]],
      ["guardian of another child", guardianB, [null, null, null, null]],
      ["owner of org A", ownerA, ["org_share", null, "case", "case"]],
      ["assigned member of org A", assignedA, ["org_share", null, "case", "case"]],
      ["unassigned member of org A", unassignedA, [null, null, null, null]],
      ["owner of org B (treats the child, no grant)", ownerB, [null, null, null, null]],
      ["owner of org C (other child)", ownerC, [null, null, null, null]],
    ];
    for (const [who, user, paths] of expected) {
      const got = [];
      for (const id of [G1, G2, P1, P2]) got.push(await pathOf(user, id));
      expect(got, who).toEqual(paths);
    }
    // The HTTP surface agrees: 302 where readable, 404 elsewhere (never 403 for other tenants).
    expect((await download(guardianA, P2)).status).toBe(404);
    expect((await download(ownerB, G1)).status).toBe(404);
    expect((await download(unassignedA, P1)).status).toBe(404);
    expect((await download(guardianB, G1)).status).toBe(404);
    expect((await download(null, G1)).status).toBe(401);
    expect((await download(ownerA, "not-a-uuid")).status).toBe(404);
    expect((await meta(ownerB, P1)).status).toBe(404);
  });

  it("E-1 download: 302 to a 300 s signed URL with the file name, no-store, strict audit document.downloaded", async () => {
    const res = await download(assignedA, G1);
    expect(res.status).toBe(302);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const location = res.headers.get("location") as string;
    const url = new URL(location);
    expect(url.pathname).toContain("/storage/v1/object/sign/documents/");
    expect(url.searchParams.get("download")).toBe("letter.pdf");
    const token = url.searchParams.get("token") as string;
    const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
    expect(claims.exp - claims.iat).toBe(300);
    const file = await fetch(location);
    expect(file.status).toBe(200);
    expect(Buffer.from(await file.arrayBuffer()).equals(PDF_BYTES)).toBe(true);
    expect(file.headers.get("content-disposition")).toContain("letter.pdf");

    const [audit] = await sql<{ actor: string; actor_user_id: string; details: Record<string, unknown> }[]>`
      select actor, actor_user_id, details from audit_events
      where action = 'document.downloaded' and entity_id = ${G1} and actor_user_id = ${assignedA.id}`;
    expect(audit).toMatchObject({ actor: "therapist", details: { child_id: childId, access: "org_share" } });
    expect(JSON.stringify(audit.details)).not.toContain("token");

    const guardian = await download(guardianA, P1);
    expect(guardian.status).toBe(302);
    const [parent] = await sql<{ actor: string; case_id: string }[]>`
      select actor, case_id from audit_events where action = 'document.downloaded' and entity_id = ${P1} and actor_user_id = ${guardianA.id}`;
    expect(parent).toEqual({ actor: "parent", case_id: caseA });
  });

  it("storage enforces expiry: an expired signed URL is refused", async () => {
    const { data } = await db.storage.from("documents").createSignedUrl(P1path, 1);
    await new Promise((r) => setTimeout(r, 2100));
    const res = await fetch(data!.signedUrl);
    expect(res.ok).toBe(false);
    expect([400, 401, 403]).toContain(res.status);
  });

  it("strict audit: if document.downloaded cannot be written there is no signed URL (503)", async () => {
    const fn = `t023_fail_dl_${P1.slice(0, 8)}`;
    await sql.unsafe(`
      create function public.${fn}() returns trigger language plpgsql as $f$
      begin raise exception 'forced audit failure (test)'; end $f$;
      create trigger ${fn} before insert on public.audit_events for each row
      when (new.action = 'document.downloaded' and new.entity_id = '${P1}') execute function public.${fn}();`);
    try {
      const res = await download(ownerA, P1);
      expect(res.status).toBe(503);
      expect(res.headers.get("location")).toBeNull();
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.text()).not.toContain("token=");
    } finally {
      await sql.unsafe(`drop trigger if exists ${fn} on public.audit_events; drop function if exists public.${fn}();`);
    }
  });

  it("metadata: readers get the document without storage path; case_id only for the case's providers", async () => {
    const g = await meta(guardianA, G1);
    expect(g.status).toBe(200);
    expect(g.headers.get("cache-control")).toBe("no-store");
    const { document } = await g.json();
    expect(document).toMatchObject({ id: G1, access: "guardian", can_delete: true, can_share: true, can_edit: false, shared_with_org_ids: [orgA] });
    expect(document).not.toHaveProperty("storage_path");
    const p = (await (await meta(guardianA, P1)).json()).document;
    expect(p).toMatchObject({ case_id: null, org_id: orgA, can_delete: false, can_edit: false });
    expect((await (await meta(assignedA, P1)).json()).document).toMatchObject({ case_id: caseA, access: "case", can_edit: true });
  });

  it("E-2: hidden provider document -> guardian 404 and not listed; ticking visibility shows it and notifies", async () => {
    expect((await store.listGuardianDocuments([childId])).map((d) => d.id)).not.toContain(P2);
    expect((await download(guardianA, P2)).status).toBe(404);
    expect((await patch(guardianA, P1, { visible_to_guardian: false })).status).toBe(403);
    expect((await patch(ownerB, P2, { visible_to_guardian: true })).status).toBe(404);
    expect((await patch(assignedA, P2, { nope: 1 })).status).toBe(400);

    const res = await patch(assignedA, P2, { visible_to_guardian: true });
    expect(res.status).toBe(200);
    expect((await res.json()).document.visible_to_guardian).toBe(true);
    const [event] = await documentEvents(sql, P2);
    expect(event).toMatchObject({ topic: "document.shared_with_guardian", payload: { document_id: P2, child_id: childId } });

    // Fan-out (FR-9): both linked guardians, in-app + email only; no title, no clinical content, no child name.
    const { fanOutDue } = await import("@/lib/notify/worker");
    await fanOutDue(sql, { eventIds: [event.id] });
    const rows = await sql<{ recipient_user_id: string; channel: string; title: string; body: string; link: string }[]>`
      select recipient_user_id, channel, title, body, link from notifications where event_id = ${event.id}
      order by recipient_user_id, channel`;
    const got = rows.map((r) => `${r.recipient_user_id}:${r.channel}`).sort();
    expect(got).toEqual([guardianA, guardianA2].flatMap((g) => [`${g.id}:email`, `${g.id}:in_app`]).sort());
    for (const r of rows) {
      expect(`${r.title} ${r.body}`).not.toMatch(/Internal note|chart|synthetic|t023/i);
      expect(r.link).toBe("/family/documents");
    }
    expect((await store.listGuardianDocuments([childId])).map((d) => d.id)).toContain(P2);
    expect((await download(guardianA, P2)).status).toBe(302);
    const [audit] = await sql<{ details: { visible_to_guardian: boolean } }[]>`
      select details from audit_events where action = 'document.visibility_changed' and entity_id = ${P2}`;
    expect(audit.details.visible_to_guardian).toBe(true);

    // Hiding never notifies; showing again does not notify twice (one event per document).
    expect((await patch(assignedA, P2, { visible_to_guardian: false })).status).toBe(200);
    expect((await patch(assignedA, P2, { visible_to_guardian: true })).status).toBe(200);
    expect((await patch(assignedA, P2, { visible_to_guardian: false })).status).toBe(200);
    expect(await documentEvents(sql, P2)).toHaveLength(1);
    expect(await pathOf(guardianA, P2)).toBeNull();

    // Recipients are re-checked at fan-out: hidden (P2 now) -> nobody; visible (P1) -> active guardians only;
    // a payload naming another child -> nobody; a guardian who left -> dropped.
    const { TOPICS } = await import("@/lib/notify/topics");
    const recipients = (documentId: string, child = childId) =>
      TOPICS["document.shared_with_guardian"].recipients({ document_id: documentId, child_id: child }, { sql, event: event as never });
    expect(await recipients(P2)).toEqual([]);
    expect((await recipients(P1)).sort()).toEqual([guardianA.id, guardianA2.id].sort());
    expect(await recipients(P1, otherChild)).toEqual([]);
    expect(await recipients(G1)).toEqual([]);
    await sql`update guardian_links set status = 'revoked', revoked_at = now() where child_id = ${childId} and user_id = ${guardianA2.id}`;
    expect(await recipients(P1)).toEqual([guardianA.id]);
    await sql`update guardian_links set status = 'active', revoked_at = null where child_id = ${childId} and user_id = ${guardianA2.id}`;
    expect(TOPICS["document.shared_with_guardian"].channels).toEqual(["in_app", "email"]);
  });

  it("FR-8 lists: case tab = case uploads + family uploads shared with the org; guardian list excludes hidden", async () => {
    const caseIds = (await store.listCaseDocuments(caseA)).map((d) => d.id);
    expect(caseIds.sort()).toEqual([G1, P1, P2].sort());
    expect(await store.listCaseDocuments(caseB)).toEqual([]);
    const listed = await store.listGuardianDocuments([childId]);
    expect(listed.map((d) => d.id).sort()).toEqual([G1, G2, P1].sort());
    expect(listed.find((d) => d.id === G1)?.shared_with_org_ids).toEqual([orgA]);
    expect(listed.find((d) => d.id === P1)?.org_name).toContain("Centre A");
  });

  it("E-4: a `documents` grant A -> B shows org A provider uploads to org B read only; revoke -> 404", async () => {
    // Wrong scope: no access.
    await grant(["reports"]); // replaced by the next grant for the same pair
    expect(await pathOf(ownerB, P1)).toBeNull();

    const grantId = await grant(["documents"]);
    expect(await pathOf(ownerB, P1)).toBe("grant");
    expect(await pathOf(ownerB, P2)).toBe("grant");
    // Family uploads not shared with org B stay hidden; unassigned members of B see nothing.
    expect(await pathOf(ownerB, G1)).toBeNull();
    expect(await pathOf(ownerB, G2)).toBeNull();
    expect(await pathOf(memberB, P1)).toBeNull();
    // Read only.
    expect((await remove(ownerB, P1)).status).toBe(403);
    expect((await patch(ownerB, P1, { visible_to_guardian: false })).status).toBe(403);
    // Download through the grant is audited with the grant id.
    expect((await download(ownerB, P1)).status).toBe(302);
    const [audit] = await sql<{ details: Record<string, unknown> }[]>`
      select details from audit_events where action = 'document.downloaded' and entity_id = ${P1} and actor_user_id = ${ownerB.id}`;
    expect(audit.details).toMatchObject({ access: "grant", grant_id: grantId });

    // Loader (registry scope `documents`): provider uploads of the source orgs only.
    const items = await loader.list({ childId, sourceOrgIds: [orgA] });
    expect(items.map((i) => i.id).sort()).toEqual([P1, P2].sort());
    expect(items.every((i) => i.sourceOrgId === orgA)).toBe(true);
    expect(await loader.get({ childId, sourceOrgIds: [orgA] }, G1)).toBeNull();
    expect(await loader.get({ childId: otherChild, sourceOrgIds: [orgA] }, P1)).toBeNull();
    expect(await loader.get({ childId, sourceOrgIds: [orgB] }, P1)).toBeNull();
    expect(await loader.get({ childId, sourceOrgIds: [] }, P1)).toBeNull();
    const detail = await loader.get({ childId, sourceOrgIds: [orgA] }, P1);
    expect(detail?.body).toEqual({ kind: "file", url: `/api/documents/${P1}/download`, fileName: "chart.png", mimeType: "image/png" });
    const { openSharedItem, listSharedForCase } = await import("@/lib/sharing/shared");
    const kaseB = { id: caseB, org_id: orgB, child_id: childId };
    const sources = await listSharedForCase(ownerB.id, kaseB);
    expect(sources[0].scopes.find((s) => s.scope === "documents")).toMatchObject({ available: true });
    expect((await openSharedItem(ownerB.id, kaseB, "documents", P1))?.item.id).toBe(P1);

    await revokeGrant(grantId);
    expect(await pathOf(ownerB, P1)).toBeNull();
    expect((await download(ownerB, P1)).status).toBe(404);
    expect(await openSharedItem(ownerB.id, kaseB, "documents", P1)).toBeNull();
  });

  it("FR-7 guardian shares: share G2 with org B, stop sharing; org without a case 422; others 404/403", async () => {
    const shares = await routes.familyShares();
    const share = await routes.familyShare();
    const shareAs = async (u: TestUser, docId: string, orgId: string, child = childId) => {
      as(u);
      return shares.POST(post("http://localhost/x", { org_id: orgId }), ctx({ id: child, docId }));
    };
    const stopAs = async (u: TestUser, docId: string, orgId: string) => {
      as(u);
      return share.DELETE(post("http://localhost/x", undefined, "DELETE"), ctx({ id: childId, docId, orgId }));
    };

    expect((await shareAs(guardianA, G2, orgC)).status).toBe(422);
    expect((await shareAs(guardianB, G2, orgB)).status).toBe(404);
    expect((await shareAs(guardianB, G2, orgB, otherChild)).status).toBe(404);
    expect((await shareAs(guardianA, P1, orgB)).status).toBe(403); // visible provider document: readable, not shareable
    expect((await shareAs(ownerA, G2, orgB)).status).toBe(403);

    // Either linked guardian may share a family upload.
    expect((await shareAs(guardianA2, G2, orgB)).status).toBe(201);
    expect(await pathOf(ownerB, G2)).toBe("org_share");
    expect(await pathOf(memberB, G2)).toBeNull();
    expect((await store.listCaseDocuments(caseB)).map((d) => d.id)).toEqual([G2]);
    const [shared] = await sql<{ actor_user_id: string }[]>`
      select actor_user_id from audit_events where action = 'document.shared' and entity_id = ${G2}`;
    expect(shared.actor_user_id).toBe(guardianA2.id);

    // The share counts only while the guardian who made it is linked (fail closed).
    await sql`update guardian_links set status = 'revoked', revoked_at = now() where child_id = ${childId} and user_id = ${guardianA2.id}`;
    expect(await pathOf(ownerB, G2)).toBeNull();
    await sql`update guardian_links set status = 'active', revoked_at = null where child_id = ${childId} and user_id = ${guardianA2.id}`;
    expect(await pathOf(ownerB, G2)).toBe("org_share");

    expect((await stopAs(guardianA, G2, orgB)).status).toBe(200);
    expect(await pathOf(ownerB, G2)).toBeNull();
    expect((await stopAs(guardianA, G2, orgB)).status).toBe(404);
    expect((await download(ownerB, G2)).status).toBe(404);
  });

  it("E-5 delete: guardian deletes own upload (object gone, listed nowhere, audited); provider documents 403", async () => {
    expect((await remove(guardianA, P1)).status).toBe(403);
    expect((await remove(guardianA2, G2)).status).toBe(403); // another guardian's upload
    expect((await remove(unassignedA, P1)).status).toBe(404);
    expect((await remove(guardianB, G2)).status).toBe(404);
    expect(await objectExists(db, G2path)).toBe(true);

    const res = await remove(guardianA, G2);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    expect(await objectExists(db, G2path)).toBe(false);
    const [row] = await sql<{ status: string; deleted_by: string }[]>`select status, deleted_by from documents where id = ${G2}`;
    expect(row).toEqual({ status: "deleted", deleted_by: guardianA.id });
    const [audit] = await sql<{ actor: string; actor_user_id: string }[]>`
      select actor, actor_user_id from audit_events where action = 'document.deleted' and entity_id = ${G2}`;
    expect(audit).toEqual({ actor: "parent", actor_user_id: guardianA.id });
    for (const u of [guardianA, guardianA2, ownerA, ownerB]) expect(await pathOf(u, G2), u.email).toBeNull();
    expect((await store.listGuardianDocuments([childId])).map((d) => d.id)).not.toContain(G2);
    expect((await meta(guardianA, G2)).status).toBe(404);
    expect((await download(guardianA, G2)).status).toBe(404);
    expect((await remove(guardianA, G2)).status).toBe(404);
  });

  it("FR-6 provider deletes: the uploader or an owner/admin of the org; not a guardian", async () => {
    // P2 was uploaded by assignedA; the org owner may delete it.
    expect((await remove(ownerA, P2)).status).toBe(200);
    expect(await pathOf(assignedA, P2)).toBeNull();
    // A plain member who did not upload cannot delete, even with case access.
    const other = await up.upload(ownerA, { caseId: caseA }, { title: "t023 owner upload", category: "medical", file_name: "m.pdf", mime_type: "application/pdf" }, PDF_BYTES);
    expect(other.completed.status).toBe(200);
    expect((await remove(assignedA, other.id)).status).toBe(403);
    expect((await remove(assignedA, P1)).status).toBe(200);
    expect(await objectExists(db, P1path)).toBe(false);
    const [audit] = await sql<{ actor: string; case_id: string }[]>`
      select actor, case_id from audit_events where action = 'document.deleted' and entity_id = ${P1}`;
    expect(audit).toEqual({ actor: "therapist", case_id: caseA });
  });

  it("RLS: readers read only documents they may read; no client writes", async () => {
    const visible = (userId: string) =>
      sql.begin(async (tx) => {
        await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, role: "authenticated" })}, true)`;
        await tx`set local role authenticated`;
        return (await tx<{ id: string }[]>`select id from documents where child_id = ${childId}`).map((r) => r.id);
      });
    expect(await visible(guardianA.id)).toContain(G1);
    expect(await visible(guardianB.id)).toEqual([]);
    expect(await visible(ownerC.id)).toEqual([]);
    expect(await visible(unassignedA.id)).toEqual([]);
    await expect(
      sql.begin(async (tx) => {
        await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: guardianA.id, role: "authenticated" })}, true)`;
        await tx`set local role authenticated`;
        await tx`update documents set visible_to_guardian = true where child_id = ${childId}`;
      }),
    ).rejects.toThrow(/permission denied/);
  });

  it("E-6 / NFR-1: the bucket has no public URL and anonymous storage reads are refused", async () => {
    const [{ storage_path }] = await sql<{ storage_path: string }[]>`select storage_path from documents where id = ${G1}`;
    const base = process.env.NEXT_PUBLIC_SUPABASE_URL as string;
    const pub = await fetch(`${base}/storage/v1/object/public/documents/${storage_path}`);
    expect(pub.ok).toBe(false);
    expect([400, 403, 404]).toContain(pub.status);
    const anonKey = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY) as string;
    const authed = await fetch(`${base}/storage/v1/object/authenticated/documents/${storage_path}`, {
      headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
    });
    expect(authed.ok).toBe(false);
  });
});
