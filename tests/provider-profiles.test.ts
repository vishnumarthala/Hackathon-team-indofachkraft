// Ticket 028: provider profiles - prescriber derivation, self-registration authorisation, owner-only edits,
// re-verification on registration edits, listing rules, public data and photo metadata stripping.
// DB parts run against the configured local Supabase (skipped without DATABASE_URL or with SKIP_DB_TESTS=1).
import { randomUUID } from "node:crypto";
import { loadEnvConfig } from "@next/env";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { canPrescribe, COUNCILS, maskRegistrationNumber, PROVIDER_TYPES, VERIFICATION_STATUSES } from "@/lib/providers/constants";
import { sniffType, stripJpegMetadata, stripPngMetadata } from "@/lib/providers/images";
import { ProfileUpdateSchema, RegisterSchema } from "@/lib/providers/schemas";
import { jsonRequest, params, providerFixtures, SYNTHETIC_PDF, syntheticJpeg, syntheticPng, type TestUser } from "./helpers/providers";

loadEnvConfig(process.cwd(), false, { info: () => {}, error: () => {} });
const enabled = Boolean(process.env.DATABASE_URL) && process.env.SKIP_DB_TESTS !== "1";

const session = vi.hoisted(() => ({ user: null as null | { id: string; email: string } }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getAuthenticatedUser: vi.fn(async () => session.user) };
});
vi.mock("next/cache", () => ({ revalidateTag: vi.fn(), unstable_cache: (fn: () => unknown) => fn }));
const email = vi.hoisted(() => ({ send: vi.fn<(input: { to: string; text: string }) => Promise<{ id: string; delivered: boolean }>>(async () => ({ id: "x", delivered: true })) }));
vi.mock("@/lib/email", () => ({ sendEmail: email.send }));

const contains = (haystack: Uint8Array, needle: string) => Buffer.from(haystack).includes(Buffer.from(needle));

describe("prescriber rule (pure)", () => {
  it("is true only for prescriber types, verified, with a medical council", () => {
    const prescribers = new Set(["developmental_pediatrician", "child_psychiatrist", "pediatrician"]);
    for (const type of PROVIDER_TYPES)
      for (const status of VERIFICATION_STATUSES)
        for (const council of COUNCILS) {
          const expected = prescribers.has(type) && status === "verified" && (council === "NMC" || council === "STATE_MEDICAL_COUNCIL");
          expect(canPrescribe(type, status, council), `${type}/${status}/${council}`).toBe(expected);
        }
    expect(canPrescribe("pediatrician", "verified", null)).toBe(false);
  });

  it("masks registration numbers to the last 4 characters", () => {
    expect(maskRegistrationNumber("TEST-ABC-001234")).toBe("••••1234");
    expect(maskRegistrationNumber(null)).toBeNull();
  });
});

describe("request schemas ignore privileged fields", () => {
  it("drops role, verification_status, can_prescribe, listed and user_id", () => {
    const body = { provider_type: "pediatrician", full_name: "Dr Synthetic", role: "platform_admin", verification_status: "verified", can_prescribe: true };
    expect(RegisterSchema.parse(body)).toEqual({ provider_type: "pediatrician", full_name: "Dr Synthetic" });
    const patch = ProfileUpdateSchema.parse({ bio: "x", listed: true, verification_status: "verified", can_prescribe: true, user_id: randomUUID() });
    expect(patch).toEqual({ bio: "x" });
  });
});

describe("post-sign-in routing for onboarding pages", () => {
  it("lets every role return to /join and /claim/<token>, other rules unchanged", async () => {
    const { postSignInPath } = await import("@/lib/auth-access");
    const claim = "/claim/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    for (const role of ["guardian", "provider", "platform_admin"] as const) {
      expect(postSignInPath(role, "/join")).toBe("/join");
      expect(postSignInPath(role, claim)).toBe(claim);
    }
    expect(postSignInPath("guardian", "/dashboard")).toBe("/family");
    expect(postSignInPath("guardian", "//evil.com/join")).toBe("/family");
  });
});

describe("image metadata stripping", () => {
  it("removes EXIF and comments from JPEG but keeps the image data", () => {
    const input = syntheticJpeg();
    expect(contains(input, "Exif")).toBe(true);
    const out = stripJpegMetadata(input);
    expect(sniffType(out)).toBe("image/jpeg");
    expect(contains(out, "Exif")).toBe(false);
    expect(contains(out, "GPS")).toBe(false);
    expect(contains(out, "camera owner")).toBe(false);
    expect(contains(out, "JFIF")).toBe(true);
    expect(Buffer.from(out.subarray(-7)).equals(Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd9]))).toBe(true);
  });

  it("removes text and eXIf chunks from PNG", () => {
    const out = stripPngMetadata(syntheticPng());
    expect(sniffType(out)).toBe("image/png");
    expect(contains(out, "Synthetic Person")).toBe(false);
    expect(contains(out, "eXIf")).toBe(false);
    expect(contains(out, "IDAT")).toBe(true);
    expect(contains(out, "IEND")).toBe(true);
  });

  it("sniffs types from bytes, not names", () => {
    expect(sniffType(SYNTHETIC_PDF)).toBe("application/pdf");
    expect(sniffType(new TextEncoder().encode("hello"))).toBeNull();
  });
});

describe.skipIf(!enabled)("provider profiles (database)", { timeout: 60_000 }, () => {
  let sql: Sql;
  let db: ReturnType<typeof import("@/lib/db").supabaseAdmin>;
  const fx = providerFixtures("t028p", () => db, () => sql);
  const as = (user: TestUser | null) => {
    session.user = user;
  };

  beforeAll(async () => {
    sql = postgres(process.env.DATABASE_URL as string, { max: 4, prepare: false, onnotice: () => {} });
    db = (await import("@/lib/db")).supabaseAdmin();
  });

  afterAll(async () => {
    await fx.cleanup();
    await sql.end({ timeout: 5 });
  });

  beforeEach(() => as(null));

  const register = async (body: Record<string, unknown>) => {
    const { POST } = await import("@/app/api/providers/register/route");
    return POST(jsonRequest("/api/providers/register", "POST", body));
  };

  const patchProfile = async (id: string, body: Record<string, unknown>) => {
    const { PATCH } = await import("@/app/api/providers/[id]/route");
    return PATCH(jsonRequest(`/api/providers/${id}`, "PATCH", body), params({ id }));
  };

  async function registered(name: string, type = "speech_language_pathologist"): Promise<{ user: TestUser; profileId: string }> {
    const user = await fx.makeUser(name);
    as(user);
    const res = await register({ provider_type: type, full_name: `t028 ${name} (synthetic)` });
    expect(res.status).toBe(201);
    return { user, profileId: (await res.json()).profile_id };
  }

  it("E-3: provider_can_prescribe truth table matches the TypeScript rule", async () => {
    const rows = await sql<{ type: string; status: string; council: string; can: boolean }[]>`
      select t.type, s.status, c.council, public.provider_prescriber_rule(t.type, s.status, c.council) as can
      from unnest(${[...PROVIDER_TYPES]}::text[]) as t(type)
      cross join unnest(${[...VERIFICATION_STATUSES]}::text[]) as s(status)
      cross join unnest(${[...COUNCILS]}::text[]) as c(council)`;
    expect(rows).toHaveLength(PROVIDER_TYPES.length * VERIFICATION_STATUSES.length * COUNCILS.length);
    for (const r of rows) expect(r.can, `${r.type}/${r.status}/${r.council}`).toBe(canPrescribe(r.type, r.status, r.council));
  });

  it("E-3: verified NMC paediatrician prescribes; psychologist and suspended paediatrician do not", async () => {
    const make = async (type: string, status: string, council: string) => {
      const [row] = await sql<{ id: string }[]>`
        insert into provider_profiles (slug, display_name, provider_type, verification_status, registration_council, registration_number, created_by)
        values (${`t028-${randomUUID().slice(0, 12)}`}, 't028 rule (synthetic)', ${type}, ${status}, ${council}, 'TEST-t028-001', ${(await fx.makeUser(`rule-${type}-${status}`)).id})
        returning id`;
      const [{ can }] = await sql<{ can: boolean }[]>`select public.provider_can_prescribe(${row.id}) as can`;
      return can;
    };
    expect(await make("pediatrician", "verified", "NMC")).toBe(true);
    expect(await make("child_psychologist", "verified", "RCI")).toBe(false);
    expect(await make("pediatrician", "suspended", "NMC")).toBe(false);
    const [{ can }] = await sql<{ can: boolean }[]>`select public.provider_can_prescribe(${randomUUID()}) as can`;
    expect(can).toBe(false);
  });

  describe("self-registration (FR-2)", () => {
    it("POST /api/providers/join creates a plain confirmed account in demo mode; 409 duplicate; 400 invalid; 429 rate limit", async () => {
      vi.stubEnv("DEMO_MODE", "true");
      const { POST } = await import("@/app/api/providers/join/route");
      const { resetJoinLimits, PER_IP_LIMIT } = await import("@/lib/providers/accounts");
      resetJoinLimits();
      const email = `t028p-join-${fx.tag}@example.com`;
      const join = (body: Record<string, unknown>) =>
        POST(new Request("http://localhost/api/providers/join", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-forwarded-for": "198.51.100.7" },
          body: JSON.stringify(body),
        }));
      const body = { provider_type: "speech_language_pathologist", full_name: "t028 Join (synthetic)", email, password: "synthetic-pass-1", role: "platform_admin" };
      const res = await join(body);
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ confirm_email: false });
      const [user] = await sql<{ id: string; confirmed: boolean }[]>`select id, email_confirmed_at is not null as confirmed from auth.users where email = ${email}`;
      fx.track(user.id);
      expect(user.confirmed).toBe(true);
      const [profile] = await sql`select role from user_profiles where id = ${user.id}`;
      expect(profile.role).toBe("guardian"); // 019 default; only register/claim promote it
      expect(await sql`select 1 from provider_profiles where user_id = ${user.id}`).toHaveLength(0);

      expect((await join(body)).status).toBe(409);
      expect((await join({ ...body, email: "not-an-email" })).status).toBe(400);
      for (let i = 3; i < PER_IP_LIMIT; i++) await join({ ...body, password: "x" });
      expect((await join(body)).status).toBe(429);
      resetJoinLimits();
      vi.unstubAllEnvs();
    });

    it("outside demo mode the account stays unconfirmed and gets a confirmation email; email failure removes it", async () => {
      vi.stubEnv("DEMO_MODE", "false");
      const { POST } = await import("@/app/api/providers/join/route");
      const { resetJoinLimits } = await import("@/lib/providers/accounts");
      resetJoinLimits();
      const join = (address: string) =>
        POST(jsonRequest("/api/providers/join", "POST", { full_name: "t028 Confirm (synthetic)", email: address, password: "synthetic-pass-1" }));
      const ok = `t028p-confirm-${fx.tag}@example.com`;
      email.send.mockClear();
      const res = await join(ok);
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ confirm_email: true });
      const [user] = await sql<{ id: string; confirmed: boolean }[]>`select id, email_confirmed_at is not null as confirmed from auth.users where email = ${ok}`;
      fx.track(user.id);
      expect(user.confirmed).toBe(false);
      expect(email.send).toHaveBeenCalledTimes(1);
      expect(email.send.mock.calls[0][0]).toMatchObject({ to: ok });
      expect(email.send.mock.calls[0][0].text).toContain("/auth/v1/verify");

      const failing = `t028p-fail-${fx.tag}@example.com`;
      email.send.mockRejectedValueOnce(new Error("resend down"));
      expect((await join(failing)).status).toBe(502);
      expect(await sql`select 1 from auth.users where email = ${failing}`).toHaveLength(0);
      resetJoinLimits();
      vi.unstubAllEnvs();
    });

    it("401 without a session", async () => {
      expect((await register({ provider_type: "pediatrician", full_name: "x" })).status).toBe(401);
    });

    it("creates a solo org, owner membership, provider role and an unlisted draft; ignores privileged body fields", async () => {
      const user = await fx.makeUser("self");
      as(user);
      const res = await register({
        provider_type: "speech_language_pathologist",
        full_name: "t028 Self Registered (synthetic)",
        role: "platform_admin",
        verification_status: "verified",
        can_prescribe: true,
        listed: true,
      });
      expect(res.status).toBe(201);
      const { profile_id, redirect } = await res.json();
      expect(redirect).toBe("/dashboard/profile");
      const [p] = await sql`select user_id, verification_status, listed, claimed, provider_type, public.provider_can_prescribe(id) as can from provider_profiles where id = ${profile_id}`;
      expect(p).toMatchObject({ user_id: user.id, verification_status: "unverified", listed: false, claimed: true, provider_type: "speech_language_pathologist", can: false });
      const [role] = await sql`select role from user_profiles where id = ${user.id}`;
      expect(role.role).toBe("provider");
      const orgs = await sql`select o.kind, m.org_role from org_members m join organizations o on o.id = m.org_id where m.user_id = ${user.id}`;
      expect(orgs).toEqual([{ kind: "solo", org_role: "owner" }]);

      const again = await register({ provider_type: "pediatrician", full_name: "again" });
      expect(again.status).toBe(200);
      expect((await again.json()).profile_id).toBe(profile_id);
    });

    it("promotes a guardian without child links, refuses platform admins", async () => {
      const guardian = await fx.makeUser("guardian-ok", "guardian");
      as(guardian);
      expect((await register({ provider_type: "occupational_therapist", full_name: "t028 G (synthetic)" })).status).toBe(201);
      const [role] = await sql`select role from user_profiles where id = ${guardian.id}`;
      expect(role.role).toBe("provider");

      const admin = await fx.makeUser("admin", "platform_admin");
      as(admin);
      const res = await register({ provider_type: "pediatrician", full_name: "t028 A (synthetic)" });
      expect(res.status).toBe(403);
      const [count] = await sql`select count(*)::int as n from provider_profiles where user_id = ${admin.id}`;
      expect(count.n).toBe(0);
    });

    it("refuses a guardian with active child links (403)", async () => {
      // 020's guardian_links (runs before this ticket's migration): a synthetic child with an active link.
      const guardian = await fx.makeUser("guardian-linked", "guardian");
      const [child] = await sql<{ id: string }[]>`
        insert into children (display_name, source, created_by) values ('t028 child (synthetic)', 'guardian', ${guardian.id})
        returning id`;
      try {
        await sql`
          insert into guardian_links (child_id, user_id, relationship, status, verification_method, declared_at)
          values (${child.id}, ${guardian.id}, 'mother', 'active', 'self_registered', now())`;
        const [{ linked }] = await sql<{ linked: boolean }[]>`select public.user_has_guardian_links(${guardian.id}) as linked`;
        expect(linked).toBe(true);
        as(guardian);
        const res = await register({ provider_type: "pediatrician", full_name: "t028 Linked (synthetic)" });
        expect(res.status).toBe(403);
        const [role] = await sql`select role from user_profiles where id = ${guardian.id}`;
        expect(role.role).toBe("guardian");
        const [count] = await sql`select count(*)::int as n from provider_profiles where user_id = ${guardian.id}`;
        expect(count.n).toBe(0);

        // A revoked link no longer blocks registration.
        await sql`update guardian_links set status = 'revoked', revoked_at = now() where child_id = ${child.id}`;
        const [{ after }] = await sql<{ after: boolean }[]>`select public.user_has_guardian_links(${guardian.id}) as after`;
        expect(after).toBe(false);
      } finally {
        await sql`delete from guardian_links where child_id = ${child.id}`;
        await sql`delete from children where id = ${child.id}`;
      }
    });
  });

  describe("owner-only edits (FR-3, E-4)", () => {
    it("owner edits; other providers get 404; guardians 403; privileged fields ignored", async () => {
      const a = await registered("owner-a");
      const b = await registered("owner-b");
      as(a.user);
      const res = await patchProfile(a.profileId, {
        bio: "Synthetic bio",
        languages: ["en", "te", "te"],
        years_experience: 7,
        verification_status: "verified",
        listed: true,
        can_prescribe: true,
        user_id: b.user.id,
      });
      expect(res.status).toBe(200);
      const { profile } = await res.json();
      expect(profile).toMatchObject({ bio: "Synthetic bio", languages: ["en", "te"], years_experience: 7, verification_status: "unverified", listed: false, user_id: a.user.id, can_prescribe: false });

      as(b.user);
      const foreign = await patchProfile(a.profileId, { bio: "hijack" });
      expect(foreign.status).toBe(404);
      expect(await foreign.json()).toEqual({ error: "Profile not found" });
      expect((await patchProfile("not-a-uuid", { bio: "x" })).status).toBe(404);
      const [row] = await sql`select bio from provider_profiles where id = ${a.profileId}`;
      expect(row.bio).toBe("Synthetic bio");

      const guardian = await fx.makeUser("guardian-edit", "guardian");
      as(guardian);
      expect((await patchProfile(a.profileId, { bio: "x" })).status).toBe(403);
      expect((await patchProfile(a.profileId, { languages: ["fr"] })).status).toBe(403);
      as(a.user);
      expect((await patchProfile(a.profileId, { languages: ["fr"] })).status).toBe(400);
      expect((await patchProfile(a.profileId, { years_experience: 61 })).status).toBe(400);
    });

    it("editing provider_type or registration fields of a verified profile resets to pending and unlists", async () => {
      const { user, profileId } = await registered("reverify", "pediatrician");
      await sql`update provider_profiles set verification_status = 'verified', verified_at = now(), registration_council = 'NMC',
        registration_number = 'TEST-t028-001', listed = true where id = ${profileId}`;
      as(user);
      const res = await patchProfile(profileId, { provider_type: "child_psychiatrist" });
      expect((await res.json()).profile).toMatchObject({ verification_status: "pending", listed: false });
      const queue = await sql`select council, registration_number, status from credential_submissions where provider_profile_id = ${profileId}`;
      expect(queue).toEqual([{ council: "NMC", registration_number: "TEST-t028-001", status: "submitted" }]);

      await sql`update provider_profiles set verification_status = 'verified', listed = true where id = ${profileId}`;
      await sql`update provider_profiles set registration_number = 'TEST-t028-002' where id = ${profileId}`;
      const [after] = await sql`select verification_status, listed from provider_profiles where id = ${profileId}`;
      expect(after).toEqual({ verification_status: "pending", listed: false });

      // Non-registration edits keep a verified profile verified.
      await sql`update provider_profiles set verification_status = 'verified', listed = true where id = ${profileId}`;
      expect((await (await patchProfile(profileId, { bio: "still verified" })).json()).profile).toMatchObject({ verification_status: "verified", listed: true });
    });

    it("FR-8: listing needs verification (API 409 and a database constraint)", async () => {
      const { user, profileId } = await registered("listing");
      as(user);
      const { PATCH } = await import("@/app/api/providers/[id]/listing/route");
      const res = await PATCH(jsonRequest(`/api/providers/${profileId}/listing`, "PATCH", { listed: true }), params({ id: profileId }));
      expect(res.status).toBe(409);
      await expect(sql`insert into provider_profiles (slug, display_name, provider_type, listed) values (${`t028-${fx.tag}-x`}, 'x', 'pediatrician', true)`).rejects.toThrow(/listed_requires_verified/);
      await sql`update provider_profiles set verification_status = 'verified' where id = ${profileId}`;
      const ok = await PATCH(jsonRequest(`/api/providers/${profileId}/listing`, "PATCH", { listed: true }), params({ id: profileId }));
      expect(ok.status).toBe(200);
    });
  });

  describe("public data (FR-7, NFR-1)", () => {
    it("only verified + listed profiles; masked registration; no email; synthetic flag honoured", async () => {
      const { loadPublicProfile } = await import("@/lib/providers/public");
      const { user, profileId } = await registered("public", "speech_language_pathologist");
      const [{ slug }] = await sql<{ slug: string }[]>`select slug from provider_profiles where id = ${profileId}`;
      expect(await loadPublicProfile(slug, true)).toBeNull();

      await sql`update provider_profiles set verification_status = 'verified', verified_at = now(), registration_council = 'RCI',
        registration_number = 'TEST-t028-009876', verification_note = 'secret note', listed = true where id = ${profileId}`;
      const data = await loadPublicProfile(slug, true);
      expect(data?.provider).toMatchObject({ council: "RCI", registration_masked: "••••9876" });
      const json = JSON.stringify(data);
      expect(json).not.toContain("TEST-t028-009876");
      expect(json).not.toContain(user.email);
      expect(json).not.toContain(user.id);
      expect(json).not.toContain("secret note");

      await sql`update provider_profiles set registration_council = 'OTHER' where id = ${profileId}`;
      await sql`update provider_profiles set verification_status = 'verified', listed = true where id = ${profileId}`;
      expect((await loadPublicProfile(slug, true))?.provider).toMatchObject({ council: null, registration_masked: null });

      await sql`update provider_profiles set is_synthetic = true where id = ${profileId}`;
      expect((await loadPublicProfile(slug, true))?.provider.is_synthetic).toBe(true);
      expect(await loadPublicProfile(slug, false)).toBeNull();

      await sql`update provider_profiles set listed = false where id = ${profileId}`;
      expect(await loadPublicProfile(slug, true)).toBeNull();
      expect(await loadPublicProfile("../etc", true)).toBeNull();
    });
  });

  describe("photo upload (FR-3, D-6)", () => {
    const upload = async (id: string, bytes: Uint8Array, type: string) => {
      const { POST } = await import("@/app/api/providers/[id]/photo/route");
      const form = new FormData();
      form.set("file", new Blob([Buffer.from(bytes)], { type }), "photo");
      return POST(new Request(`http://localhost/api/providers/${id}/photo`, { method: "POST", body: form }), params({ id }));
    };

    it("stores JPEG/PNG without metadata under a random name; rejects other types and > 2 MB; owner only", async () => {
      const { user, profileId } = await registered("photo");
      as(user);
      const res = await upload(profileId, syntheticJpeg(), "image/jpeg");
      expect(res.status).toBe(201);
      const [{ photo_path }] = await sql<{ photo_path: string }[]>`select photo_path from provider_profiles where id = ${profileId}`;
      expect(photo_path).toMatch(new RegExp(`^${profileId}/[0-9a-f-]{36}\\.jpg$`));
      const { data } = await db.storage.from("provider-photos").download(photo_path);
      const stored = new Uint8Array(await data!.arrayBuffer());
      expect(contains(stored, "Exif")).toBe(false);
      expect(contains(stored, "GPS")).toBe(false);

      expect((await upload(profileId, syntheticPng(), "image/png")).status).toBe(201);
      const removed = await db.storage.from("provider-photos").download(photo_path);
      expect(removed.data).toBeNull();

      expect((await upload(profileId, SYNTHETIC_PDF, "image/jpeg")).status).toBe(400);
      const big = new Uint8Array(2 * 1024 * 1024 + 1);
      big.set(syntheticJpeg());
      expect((await upload(profileId, big, "image/jpeg")).status).toBe(400);

      const other = await registered("photo-other");
      as(other.user);
      expect((await upload(profileId, syntheticJpeg(), "image/jpeg")).status).toBe(404);
    });
  });
});
