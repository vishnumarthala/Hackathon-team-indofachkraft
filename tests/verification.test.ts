// Ticket 028: credential submission, platform-admin verification queue (approve / reject / suspend),
// strict audit, certificate access and admin-only routes. Runs against the configured local Supabase
// (skipped without DATABASE_URL or with SKIP_DB_TESTS=1). Synthetic people and fake registration numbers only.
import { loadEnvConfig } from "@next/env";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { registerSearchUrl } from "@/lib/providers/constants";
import { jsonRequest, params, providerFixtures, SYNTHETIC_PDF, type TestUser } from "./helpers/providers";

loadEnvConfig(process.cwd(), false, { info: () => {}, error: () => {} });
const enabled = Boolean(process.env.DATABASE_URL) && process.env.SKIP_DB_TESTS !== "1";

const session = vi.hoisted(() => ({ user: null as null | { id: string; email: string } }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getAuthenticatedUser: vi.fn(async () => session.user) };
});
vi.mock("next/cache", () => ({ revalidateTag: vi.fn(), unstable_cache: (fn: () => unknown) => fn }));
// 032: decisions enqueue outbox events in the deciding transaction; the immediate drain is not under test here.
const drain = vi.hoisted(() => vi.fn());
vi.mock("@/lib/notify/outbox", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/notify/outbox")>();
  return { ...actual, drainSoon: drain };
});

describe("public register links", () => {
  it("link NMC/state councils and RCI, none for OTHER", () => {
    expect(registerSearchUrl("NMC")).toMatch(/^https:\/\/www\.nmc\.org\.in\//);
    expect(registerSearchUrl("STATE_MEDICAL_COUNCIL")).toMatch(/^https:\/\//);
    expect(registerSearchUrl("RCI")).toMatch(/^https:\/\/rehabcouncil\.nic\.in/);
    expect(registerSearchUrl("OTHER")).toBeNull();
  });
});

describe.skipIf(!enabled)("credential verification (database)", { timeout: 60_000 }, () => {
  let sql: Sql;
  let db: ReturnType<typeof import("@/lib/db").supabaseAdmin>;
  const fx = providerFixtures("t028v", () => db, () => sql);
  let admin: TestUser;
  const as = (user: TestUser | null) => {
    session.user = user;
  };

  beforeAll(async () => {
    sql = postgres(process.env.DATABASE_URL as string, { max: 4, prepare: false, onnotice: () => {} });
    db = (await import("@/lib/db")).supabaseAdmin();
    admin = await fx.makeUser("admin", "platform_admin");
  });

  afterAll(async () => {
    await fx.cleanup();
    await sql.end({ timeout: 5 });
  });

  const outbox = (topic: string, profileId: string) =>
    sql`select payload, dedup_key from outbox_events where topic = ${topic} and aggregate_id = ${profileId}`;

  beforeEach(() => {
    as(null);
    drain.mockClear();
  });

  async function registered(name: string, type: string): Promise<{ user: TestUser; profileId: string; slug: string }> {
    const user = await fx.makeUser(name);
    as(user);
    const { POST } = await import("@/app/api/providers/register/route");
    const res = await POST(jsonRequest("/api/providers/register", "POST", { provider_type: type, full_name: `t028 ${name} (synthetic)` }));
    const { profile_id } = await res.json();
    const [{ slug }] = await sql<{ slug: string }[]>`select slug from provider_profiles where id = ${profile_id}`;
    return { user, profileId: profile_id, slug };
  }

  async function uploadCertificate(profileId: string, bytes: Uint8Array = SYNTHETIC_PDF, mime = "application/pdf"): Promise<string> {
    const { POST } = await import("@/app/api/providers/[id]/credentials/upload-url/route");
    const res = await POST(
      jsonRequest(`/api/providers/${profileId}/credentials/upload-url`, "POST", { file_name: "cert.pdf", mime_type: mime, size_bytes: bytes.length }),
      params({ id: profileId }),
    );
    expect(res.status).toBe(201);
    const { path, token } = await res.json();
    const { error } = await db.storage.from("credentials").uploadToSignedUrl(path, token, Buffer.from(bytes), { contentType: mime });
    expect(error).toBeNull();
    return path;
  }

  async function submit(profileId: string, body: Record<string, unknown>) {
    const { POST } = await import("@/app/api/providers/[id]/credentials/route");
    return POST(jsonRequest(`/api/providers/${profileId}/credentials`, "POST", body), params({ id: profileId }));
  }

  async function review(submissionId: string, body: Record<string, unknown>) {
    const { POST } = await import("@/app/api/admin/verifications/[id]/route");
    return POST(jsonRequest(`/api/admin/verifications/${submissionId}`, "POST", body), params({ id: submissionId }));
  }

  async function setListed(profileId: string, listed: boolean) {
    const { PATCH } = await import("@/app/api/providers/[id]/listing/route");
    return PATCH(jsonRequest(`/api/providers/${profileId}/listing`, "PATCH", { listed }), params({ id: profileId }));
  }

  const profileRow = async (id: string) =>
    (await sql`select verification_status, listed, verified_by, verified_at, verification_note, registration_council, registration_number
      from provider_profiles where id = ${id}`)[0];

  it("E-1: submit (RCI + PDF) -> pending; admin approves -> verified; listing allowed; public page shows masked number", async () => {
    const { loadPublicProfile } = await import("@/lib/providers/public");
    const p = await registered("slp", "speech_language_pathologist");
    as(p.user);
    const path = await uploadCertificate(p.profileId);
    const res = await submit(p.profileId, { council: "RCI", registration_number: `TEST-${fx.tag}-001`, certificate_path: path, verification_status: "verified" });
    expect(res.status).toBe(201);
    const { submission_id } = await res.json();
    expect(await profileRow(p.profileId)).toMatchObject({ verification_status: "pending", listed: false, registration_council: "RCI" });
    expect((await setListed(p.profileId, true)).status).toBe(409);

    const { listPendingSubmissions } = await import("@/lib/providers/verification");
    expect((await listPendingSubmissions()).map((s) => s.id)).toContain(submission_id);

    as(p.user);
    expect((await review(submission_id, { action: "approve" })).status).toBe(403);

    as(admin);
    const approved = await review(submission_id, { action: "approve" });
    expect(approved.status).toBe(200);
    expect(await profileRow(p.profileId)).toMatchObject({ verification_status: "verified", verified_by: admin.id, listed: false });
    expect(await outbox("provider.verified", p.profileId)).toEqual([
      { payload: { provider_profile_id: p.profileId, submission_id }, dedup_key: `provider.verified:${submission_id}` },
    ]);
    expect(drain).toHaveBeenCalled();
    const [auditRow] = await sql`select actor_user_id, details from audit_events where action = 'provider.verified' and entity_id = ${p.profileId}`;
    expect(auditRow.actor_user_id).toBe(admin.id);
    expect(auditRow.details).toMatchObject({ submission_id, council: "RCI" });
    expect((await review(submission_id, { action: "approve" })).status).toBe(404);

    as(p.user);
    expect((await setListed(p.profileId, true)).status).toBe(200);
    const pub = await loadPublicProfile(p.slug, true);
    expect(pub?.provider).toMatchObject({ council: "RCI", registration_masked: "••••-001" });
    expect(JSON.stringify(pub)).not.toContain(p.user.email);

    // E-1 step 4: new registration number -> pending, unlisted, public page gone.
    const path2 = await uploadCertificate(p.profileId);
    expect((await submit(p.profileId, { council: "RCI", registration_number: `TEST-${fx.tag}-002`, certificate_path: path2 })).status).toBe(201);
    expect(await profileRow(p.profileId)).toMatchObject({ verification_status: "pending", listed: false, registration_number: `TEST-${fx.tag}-002` });
    expect(await loadPublicProfile(p.slug, true)).toBeNull();

    // A second submission while one is open replaces it and deletes the old certificate object.
    const path3 = await uploadCertificate(p.profileId);
    expect((await submit(p.profileId, { council: "RCI", registration_number: `TEST-${fx.tag}-003`, certificate_path: path3 })).status).toBe(201);
    const open = await sql`select certificate_path from credential_submissions where provider_profile_id = ${p.profileId} and status = 'submitted'`;
    expect(open).toEqual([{ certificate_path: path3 }]);
    expect((await db.storage.from("credentials").download(path2)).data).toBeNull();
  });

  it("rejects bad certificates: another profile's path, wrong bytes, missing state for State Medical Council", async () => {
    const a = await registered("cert-a", "pediatrician");
    const b = await registered("cert-b", "pediatrician");
    as(b.user);
    const bPath = await uploadCertificate(b.profileId);
    as(a.user);
    const foreign = await submit(a.profileId, { council: "NMC", registration_number: "TEST-x-1", certificate_path: bPath });
    expect(foreign.status).toBe(400);

    const fake = await uploadCertificate(a.profileId, new TextEncoder().encode("not really a pdf"), "application/pdf");
    expect((await submit(a.profileId, { council: "NMC", registration_number: "TEST-x-1", certificate_path: fake })).status).toBe(400);
    expect((await db.storage.from("credentials").download(fake)).data).toBeNull();

    const path = await uploadCertificate(a.profileId);
    expect((await submit(a.profileId, { council: "STATE_MEDICAL_COUNCIL", registration_number: "TEST-x-1", certificate_path: path })).status).toBe(400);
    expect((await submit(a.profileId, { council: "STATE_MEDICAL_COUNCIL", state: "Telangana", registration_number: "TEST-x-1", certificate_path: path })).status).toBe(201);

    as(b.user);
    expect((await submit(a.profileId, { council: "NMC", registration_number: "TEST-x-1", certificate_path: path })).status).toBe(404);
  });

  it("council OTHER: approval needs a note (stored, audited, never public); reject needs a note", async () => {
    const { loadPublicProfile } = await import("@/lib/providers/public");
    const ot = await registered("ot", "occupational_therapist");
    as(ot.user);
    const res = await submit(ot.profileId, { council: "OTHER", registration_number: "TEST-ot-DEGREE", certificate_path: await uploadCertificate(ot.profileId) });
    const { submission_id } = await res.json();

    as(admin);
    expect((await review(submission_id, { action: "approve" })).status).toBe(400);
    expect((await review(submission_id, { action: "approve", note: "   " })).status).toBe(400);
    expect((await review(submission_id, { action: "approve", note: "Checked synthetic BOT degree certificate" })).status).toBe(200);
    expect(await profileRow(ot.profileId)).toMatchObject({ verification_status: "verified", verification_note: "Checked synthetic BOT degree certificate" });
    as(ot.user);
    await setListed(ot.profileId, true);
    const pub = await loadPublicProfile(ot.slug, true);
    expect(pub?.provider).toMatchObject({ council: null, registration_masked: null });
    expect(JSON.stringify(pub)).not.toContain("Checked synthetic");

    const slp = await registered("rejected", "speech_language_pathologist");
    as(slp.user);
    const sub = (await (await submit(slp.profileId, { council: "RCI", registration_number: "TEST-r-1", certificate_path: await uploadCertificate(slp.profileId) })).json()).submission_id;
    as(admin);
    expect((await review(sub, { action: "reject" })).status).toBe(400);
    expect((await review(sub, { action: "reject", note: "Number not found on the register" })).status).toBe(200);
    expect(await profileRow(slp.profileId)).toMatchObject({ verification_status: "rejected", listed: false });
    const [auditRow] = await sql`select actor_user_id from audit_events where action = 'provider.rejected' and entity_id = ${slp.profileId}`;
    expect(auditRow.actor_user_id).toBe(admin.id);
    expect(await outbox("provider.rejected", slp.profileId)).toHaveLength(1);
  });

  it("suspend: verified only, note required, unlists, blocks resubmission, audited", async () => {
    const { POST } = await import("@/app/api/admin/providers/[id]/suspend/route");
    const suspend = (id: string, body: Record<string, unknown>) => POST(jsonRequest(`/api/admin/providers/${id}/suspend`, "POST", body), params({ id }));
    const p = await registered("suspend", "pediatrician");
    as(admin);
    expect((await suspend(p.profileId, { note: "x" })).status).toBe(409);
    await sql`update provider_profiles set verification_status = 'verified', registration_council = 'NMC', registration_number = 'TEST-s-1', listed = true where id = ${p.profileId}`;
    expect((await suspend(p.profileId, { note: "" })).status).toBe(400);
    as(p.user);
    expect((await suspend(p.profileId, { note: "self" })).status).toBe(403);
    as(admin);
    expect((await suspend(p.profileId, { note: "Complaint under review (synthetic)" })).status).toBe(200);
    expect(await profileRow(p.profileId)).toMatchObject({ verification_status: "suspended", listed: false });
    const [{ can }] = await sql`select public.provider_can_prescribe(${p.profileId}) as can`;
    expect(can).toBe(false);
    const [auditRow] = await sql`select actor_user_id, details from audit_events where action = 'provider.suspended' and entity_id = ${p.profileId}`;
    expect(auditRow).toMatchObject({ actor_user_id: admin.id, details: { note: "Complaint under review (synthetic)" } });
    expect(await sql`select payload from outbox_events where topic = 'provider.suspended' and aggregate_id = ${p.profileId}`).toEqual([
      { payload: { provider_profile_id: p.profileId } },
    ]);

    as(p.user);
    const res = await submit(p.profileId, { council: "NMC", registration_number: "TEST-s-2", certificate_path: await uploadCertificate(p.profileId) });
    expect(res.status).toBe(409);
    expect((await setListed(p.profileId, true)).status).toBe(409);
  });

  it("E-4: admin routes are platform-admin only; certificate is a short-lived signed redirect", async () => {
    const p = await registered("authz", "child_psychologist");
    as(p.user);
    const res = await submit(p.profileId, { council: "RCI", registration_number: "TEST-a-1", certificate_path: await uploadCertificate(p.profileId) });
    const { submission_id } = await res.json();

    const { POST: seed } = await import("@/app/api/admin/providers/route");
    const { POST: claimLink } = await import("@/app/api/admin/providers/[id]/claim-link/route");
    const { GET: certificate } = await import("@/app/api/admin/verifications/[id]/certificate/route");
    const calls = () => [
      seed(jsonRequest("/api/admin/providers", "POST", {})),
      claimLink(jsonRequest(`/api/admin/providers/${p.profileId}/claim-link`, "POST"), params({ id: p.profileId })),
      certificate(jsonRequest(`/api/admin/verifications/${submission_id}/certificate`, "GET"), params({ id: submission_id })),
      review(submission_id, { action: "approve" }),
    ];
    as(null);
    for (const r of await Promise.all(calls())) expect(r.status).toBe(401);
    as(p.user);
    for (const r of await Promise.all(calls())) {
      expect(r.status).toBe(403);
      expect(await r.json()).toEqual({ error: "Platform admin access required" });
    }
    const guardian = await fx.makeUser("guardian", "guardian");
    as(guardian);
    for (const r of await Promise.all(calls())) expect(r.status).toBe(403);

    as(admin);
    const cert = await certificate(jsonRequest(`/api/admin/verifications/${submission_id}/certificate`, "GET"), params({ id: submission_id }));
    expect(cert.status).toBe(302);
    const location = cert.headers.get("location") ?? "";
    expect(location).toContain("/storage/v1/object/sign/credentials/");
    const signed = await fetch(location);
    expect(signed.status).toBe(200);
    expect(Buffer.from(await signed.arrayBuffer()).subarray(0, 5).toString()).toBe("%PDF-");
    const [viewed] = await sql`select actor_user_id from audit_events where action = 'provider.certificate_viewed' and entity_id = ${submission_id}`;
    expect(viewed.actor_user_id).toBe(admin.id);

    // Credentials are not publicly readable.
    const [{ certificate_path }] = await sql`select certificate_path from credential_submissions where id = ${submission_id}`;
    const pub = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/credentials/${certificate_path}`);
    expect(pub.ok).toBe(false);
    await sql`delete from audit_events where entity_id = ${submission_id}`;
  });
});
