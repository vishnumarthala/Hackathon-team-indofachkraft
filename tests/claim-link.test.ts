// Ticket 028: admin seeding and claim links - hash-only storage, single use, expiry, new link revokes old,
// claim binds the user and makes them owner of the seeded organisation, 409 for users who already have a
// profile, concurrency. Runs against the configured local Supabase (skipped without DATABASE_URL or with
// SKIP_DB_TESTS=1). Synthetic people, clinics and fake registration numbers only.
import { loadEnvConfig } from "@next/env";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hashToken } from "@/lib/orgs";
import { jsonRequest, params, providerFixtures, type TestUser } from "./helpers/providers";

loadEnvConfig(process.cwd(), false, { info: () => {}, error: () => {} });
const enabled = Boolean(process.env.DATABASE_URL) && process.env.SKIP_DB_TESTS !== "1";

const session = vi.hoisted(() => ({ user: null as null | { id: string; email: string } }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getAuthenticatedUser: vi.fn(async () => session.user) };
});
vi.mock("next/cache", () => ({ revalidateTag: vi.fn(), unstable_cache: (fn: () => unknown) => fn }));

describe.skipIf(!enabled)("admin seeding and claim links (database)", { timeout: 60_000 }, () => {
  let sql: Sql;
  let db: ReturnType<typeof import("@/lib/db").supabaseAdmin>;
  const fx = providerFixtures("t028c", () => db, () => sql);
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

  beforeEach(() => as(null));

  const seedBody = (extra: Record<string, unknown> = {}) => ({
    org_name: `t028 ${fx.tag} Synthetic Child Clinic`,
    org_kind: "centre",
    phone_public: "+91 40 0000 0000",
    location: { name: "Main branch", address_line1: "1 Synthetic Road", locality: "Madhapur", pincode: "500081" },
    display_name: `Dr t028 ${fx.tag} Paediatrician (synthetic)`,
    provider_type: "pediatrician",
    languages: ["en", "te"],
    registration_council: "NMC",
    registration_number: `TEST-${fx.tag}-001`,
    ...extra,
  });

  async function seed(body: Record<string, unknown>) {
    const { POST } = await import("@/app/api/admin/providers/route");
    return POST(jsonRequest("/api/admin/providers", "POST", body));
  }

  async function claimLink(profileId: string) {
    const { POST } = await import("@/app/api/admin/providers/[id]/claim-link/route");
    return POST(jsonRequest(`/api/admin/providers/${profileId}/claim-link`, "POST"), params({ id: profileId }));
  }

  async function claim(token: string) {
    const { POST } = await import("@/app/api/claims/[token]/route");
    return POST(jsonRequest(`/api/claims/${token}`, "POST"), params({ token }));
  }

  const tokenOf = (url: string) => url.split("/claim/")[1];

  it("E-2: seed centre + paediatrician, create link, fresh user claims, link is single-use", async () => {
    as(admin);
    const res = await seed(seedBody({ verified: false, role: "platform_admin", listed: true }));
    expect(res.status).toBe(201);
    const { profile_id, org_id, location_id } = await res.json();
    const [profile] = await sql`select user_id, verification_status, listed, claimed, created_by from provider_profiles where id = ${profile_id}`;
    expect(profile).toEqual({ user_id: null, verification_status: "unverified", listed: false, claimed: false, created_by: admin.id });
    const [org] = await sql`select kind, listed, public_name, phone_public from organizations where id = ${org_id}`;
    expect(org).toMatchObject({ kind: "centre", listed: false, phone_public: "+91 40 0000 0000" });
    const [loc] = await sql`select city, state, locality, pincode from practice_locations where id = ${location_id}`;
    expect(loc).toEqual({ city: "Hyderabad", state: "Telangana", locality: "Madhapur", pincode: "500081" });
    expect(await sql`select org_id from provider_locations where provider_profile_id = ${profile_id}`).toEqual([{ org_id }]);
    const members = await sql`select 1 from org_members where org_id = ${org_id}`;
    expect(members).toHaveLength(0);

    const link = await claimLink(profile_id);
    expect(link.status).toBe(201);
    const { url, expires_at } = await link.json();
    expect(url).toMatch(/\/claim\/[A-Za-z0-9_-]{43}$/);
    const token = tokenOf(url);
    const days = (new Date(expires_at).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(13.9);
    expect(days).toBeLessThanOrEqual(14);
    const stored = await sql`select token_hash from provider_claim_tokens where provider_profile_id = ${profile_id}`;
    expect(stored).toEqual([{ token_hash: hashToken(token) }]);
    const [{ leaks }] = await sql`select count(*)::int as leaks from provider_claim_tokens where token_hash = ${token} or token_hash like ${"%" + token.slice(0, 20) + "%"}`;
    expect(leaks).toBe(0);

    const { previewClaim } = await import("@/lib/providers/claims");
    expect(await previewClaim(token)).toMatchObject({ provider_type: "pediatrician" });

    as(null);
    expect((await claim(token)).status).toBe(401);

    const fresh = await fx.makeUser("fresh", "guardian");
    as(fresh);
    const claimed = await claim(token);
    expect(claimed.status).toBe(200);
    expect(await claimed.json()).toMatchObject({ profile_id, redirect: "/dashboard/profile" });
    expect((await sql`select user_id, claimed from provider_profiles where id = ${profile_id}`)[0]).toEqual({ user_id: fresh.id, claimed: true });
    // 032: the claim transaction enqueued exactly one provider.claimed event.
    expect(await sql`select payload from outbox_events where topic = 'provider.claimed' and aggregate_id = ${profile_id}`).toEqual([
      { payload: { provider_profile_id: profile_id } },
    ]);
    expect(await sql`select org_role, status from org_members where org_id = ${org_id} and user_id = ${fresh.id}`).toEqual([{ org_role: "owner", status: "active" }]);
    expect((await sql`select role from user_profiles where id = ${fresh.id}`)[0].role).toBe("provider");

    const other = await fx.makeUser("other");
    as(other);
    const reuse = await claim(token);
    expect(reuse.status).toBe(404);
    expect(await reuse.json()).toEqual({ error: "This link is not valid." });
    expect(await previewClaim(token)).toBeNull();

    as(admin);
    expect((await claimLink(profile_id)).status).toBe(409);
  });

  it("a new link invalidates the old one; expired and malformed links are invalid", async () => {
    as(admin);
    const { profile_id } = await (await seed(seedBody({ display_name: `t028 ${fx.tag} SLP (synthetic)`, provider_type: "speech_language_pathologist", registration_council: "RCI" }))).json();
    const first = tokenOf((await (await claimLink(profile_id)).json()).url);
    const second = tokenOf((await (await claimLink(profile_id)).json()).url);
    expect(first).not.toBe(second);

    const { createClaimLink, previewClaim } = await import("@/lib/providers/claims");
    const expired = await createClaimLink(profile_id, admin.id, new Date(Date.now() - 15 * 86_400_000));
    if (!expired.ok) throw new Error("expected a token");

    const user = await fx.makeUser("rotate");
    as(user);
    expect(await previewClaim(first)).toBeNull();
    expect((await claim(first)).status).toBe(404);
    expect((await claim(second)).status).toBe(404); // revoked by the expired link created after it
    expect((await claim(expired.data.token)).status).toBe(404);
    expect((await claim("short")).status).toBe(404);

    as(admin);
    const fresh = tokenOf((await (await claimLink(profile_id)).json()).url);
    as(user);
    expect((await claim(fresh)).status).toBe(200);
  });

  it("409 for a user who already has a profile; 403 for platform admins; concurrent claims -> one winner", async () => {
    const provider = await fx.makeUser("has-profile");
    as(provider);
    const { POST: register } = await import("@/app/api/providers/register/route");
    expect((await register(jsonRequest("/api/providers/register", "POST", { provider_type: "pediatrician", full_name: "t028 Existing (synthetic)" }))).status).toBe(201);

    as(admin);
    const { profile_id } = await (await seed(seedBody({ display_name: `t028 ${fx.tag} Psychologist (synthetic)`, provider_type: "child_psychologist", registration_council: "RCI" }))).json();
    const token = tokenOf((await (await claimLink(profile_id)).json()).url);

    as(provider);
    const conflict = await claim(token);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: "You already have a profile" });
    as(admin);
    expect((await claim(token)).status).toBe(403);

    const { claimProfile } = await import("@/lib/providers/claims");
    const [u1, u2] = await Promise.all([fx.makeUser("race-1"), fx.makeUser("race-2")]);
    const results = await Promise.all([claimProfile(token, u1.id), claimProfile(token, u2.id)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.status === 404)).toHaveLength(1);
  });

  it("seeding with verification lists the profile and its centre; second provider joins an existing centre", async () => {
    const { loadPublicCentre, loadPublicProfile } = await import("@/lib/providers/public");
    as(admin);
    expect((await seed(seedBody({ verified: true, registration_council: "OTHER", provider_type: "special_educator" }))).status).toBe(400);
    const res = await seed(seedBody({ verified: true, verification_note: "Checked synthetic NMC entry", is_synthetic: true }));
    expect(res.status).toBe(201);
    const { profile_id, org_id, location_id, slug } = await res.json();
    expect((await sql`select verification_status, listed, verified_by from provider_profiles where id = ${profile_id}`)[0]).toEqual({ verification_status: "verified", listed: true, verified_by: admin.id });
    expect((await sql`select actor_user_id from audit_events where action = 'provider.verified' and entity_id = ${profile_id}`)[0].actor_user_id).toBe(admin.id);
    const pub = await loadPublicProfile(slug, true);
    expect(pub?.provider).toMatchObject({ is_synthetic: true, council: "NMC", registration_masked: "••••-001" });
    expect(pub?.locations[0]).toMatchObject({ locality: "Madhapur", org: { kind: "centre", phone_public: "+91 40 0000 0000" } });

    const second = await seed({ org_id, location_id, display_name: `t028 ${fx.tag} OT (synthetic)`, provider_type: "occupational_therapist" });
    expect(second.status).toBe(201);
    const [{ orgSlug }] = await sql<{ orgSlug: string }[]>`select slug as "orgSlug" from organizations where id = ${org_id}`;
    const centre = await loadPublicCentre(orgSlug, true);
    expect(centre?.providers.map((p) => p.id)).toEqual([profile_id]);
    expect(await loadPublicCentre(orgSlug, false)).toBeNull();

    const provider = await fx.makeUser("seed-attempt");
    await sql`update user_profiles set role = 'provider' where id = ${provider.id}`;
    as(provider);
    expect((await seed(seedBody())).status).toBe(403);
  });
});
