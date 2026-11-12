// Ticket 019 FR-2/FR-5/FR-8/FR-10: requireGuardian(), the static "every family route is gated" scan, the
// profile API, and the role trigger. The database block uses the configured local Supabase with synthetic
// users that are deleted afterwards (skipped without DATABASE_URL or with SKIP_DB_TESTS=1).
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { loadEnvConfig } from "@next/env";
import { createClient } from "@supabase/supabase-js";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

loadEnvConfig(process.cwd(), false, { info: () => {}, error: () => {} });
const enabled = Boolean(process.env.DATABASE_URL) && process.env.SKIP_DB_TESTS !== "1";

const session = vi.hoisted(() => ({ user: null as null | { id: string; email?: string } }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getAuthenticatedUser: vi.fn(async () => session.user) };
});

// `undefined` = real database; otherwise profile reads return `row` and writes are recorded.
const fake = vi.hoisted(() => ({
  row: undefined as undefined | Record<string, unknown>,
  updates: [] as unknown[],
}));
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return {
    ...actual,
    supabaseAdmin: vi.fn(() => {
      if (fake.row === undefined) return actual.supabaseAdmin();
      const chain = {
        select: () => chain,
        eq: () => chain,
        update: (values: unknown) => {
          fake.updates.push(values);
          return chain;
        },
        insert: async () => ({ error: null }),
        single: async () => ({ data: fake.row, error: null }),
        maybeSingle: async () => ({ data: fake.row, error: null }),
      };
      return { from: () => chain };
    }),
  };
});

import { requireGuardian } from "@/lib/authz";

const ROOT = process.cwd();

function filesUnder(dir: string, name: RegExp): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...filesUnder(full, name));
    else if (name.test(entry)) out.push(full);
  }
  return out;
}

function patchProfile(body: unknown) {
  return import("@/app/api/family/profile/route").then(({ PATCH }) =>
    PATCH(
      new Request("http://localhost/api/family/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    ),
  );
}

const profileRow = (role: string) => ({
  id: "00000000-0000-4000-8000-0000000000aa",
  role,
  display_name: null,
  preferred_locale: null,
  phone_verified_at: null,
});

describe("requireGuardian (FR-5)", () => {
  beforeEach(() => {
    session.user = null;
    fake.row = profileRow("guardian");
    fake.updates = [];
  });

  it("401 without a session", async () => {
    const res = await requireGuardian();
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(401);
    expect(await (res as Response).json()).toEqual({ error: "Authentication required" });
  });

  it.each(["provider", "platform_admin"])("403 Not allowed for %s", async (role) => {
    session.user = { id: "00000000-0000-4000-8000-0000000000aa" };
    fake.row = profileRow(role);
    const res = (await requireGuardian()) as Response;
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Not allowed" });
  });

  it("returns the user and profile for guardians", async () => {
    session.user = { id: "00000000-0000-4000-8000-0000000000aa" };
    const res = await requireGuardian();
    expect(res).not.toBeInstanceOf(Response);
    expect(res).toMatchObject({ user: { id: session.user.id }, profile: { role: "guardian" } });
  });

  it("PATCH /api/family/profile never accepts role (400, nothing written)", async () => {
    session.user = { id: "00000000-0000-4000-8000-0000000000aa" };
    for (const body of [{ role: "platform_admin" }, { display_name: "Asha", role: "provider" }, { display_name: "" }, { display_name: "x".repeat(81) }, {}]) {
      expect((await patchProfile(body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(fake.updates).toEqual([]);
    expect((await patchProfile({ display_name: "  Asha  " })).status).toBe(200);
    expect(fake.updates).toEqual([{ display_name: "Asha" }]);
  });
});

describe("every family route and page is gated (static scan)", () => {
  it("each handler in app/api/family/** calls requireGuardian() first", () => {
    const routes = filesUnder(path.join(ROOT, "app/api/family"), /^route\.ts$/);
    expect(routes.length).toBeGreaterThanOrEqual(3);
    for (const file of routes) {
      const source = readFileSync(file, "utf8");
      const handlers = [...source.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)\([^)]*\)\s*\{\s*([^\n]*)\n\s*([^\n]*)/g)];
      expect(handlers.length, file).toBeGreaterThan(0);
      for (const [, method, first, second] of handlers) {
        expect(first, `${file} ${method}`).toMatch(/await requireGuardian\(\)/);
        expect(second, `${file} ${method}`).toMatch(/instanceof Response\) return/);
      }
    }
  });

  it("each /family portal page and layout calls requireGuardianPage()", () => {
    const familyDir = path.join(ROOT, "app/family");
    const files = filesUnder(familyDir, /^(page|layout)\.tsx$/).filter(
      // The sign-in page is public; the shared /family layout only renders the emergency footer.
      (file) => !file.includes(`${path.sep}login${path.sep}`) && file !== path.join(familyDir, "layout.tsx"),
    );
    expect(files.length).toBeGreaterThanOrEqual(7);
    for (const file of files) expect(readFileSync(file, "utf8"), file).toMatch(/await requireGuardianPage\(\)/);
  });
});

describe.skipIf(!enabled)("guardian roles in the database (FR-2, FR-8, FR-10)", { timeout: 60_000 }, () => {
  let sql: Sql;
  let db: ReturnType<typeof import("@/lib/db").supabaseAdmin>;
  const users: string[] = [];
  const tag = randomUUID().slice(0, 8);

  async function makeUser(name: string, extra: Record<string, unknown> = {}) {
    const email = `t019-${name}-${tag}@example.com`;
    const password = randomUUID();
    const { data, error } = await db.auth.admin.createUser({ email, email_confirm: true, password, ...extra });
    if (error || !data.user) throw new Error(`createUser failed: ${error?.message}`);
    users.push(data.user.id);
    return { id: data.user.id, email, password };
  }

  const roleOf = async (id: string) =>
    (await sql<{ role: string; phone_verified_at: Date | null }[]>`select role, phone_verified_at from user_profiles where id = ${id}`)[0];

  beforeAll(async () => {
    fake.row = undefined;
    sql = postgres(process.env.DATABASE_URL as string, { max: 2, prepare: false, onnotice: () => {} });
    db = (await import("@/lib/db")).supabaseAdmin();
  });

  beforeEach(() => {
    fake.row = undefined;
    session.user = null;
  });

  afterAll(async () => {
    for (const id of users) await db.auth.admin.deleteUser(id);
    await sql?.end({ timeout: 5 });
  });

  it("new accounts are guardians; only server-set app_metadata grants provider/platform_admin", async () => {
    const plain = await makeUser("plain", { user_metadata: { role: "platform_admin" } });
    const provider = await makeUser("provider", { app_metadata: { role: "provider" } });
    const admin = await makeUser("admin", { app_metadata: { role: "platform_admin" } });
    expect((await roleOf(plain.id)).role).toBe("guardian");
    expect((await roleOf(provider.id)).role).toBe("provider");
    expect((await roleOf(admin.id)).role).toBe("platform_admin");
  });

  it("phone_verified_at mirrors the confirmed phone (set, changed, cleared)", async () => {
    const phone = `9190${String(Date.now()).slice(-8)}`;
    const { data } = await db.auth.admin.createUser({ phone, phone_confirm: true });
    users.push(data.user!.id);
    const created = await roleOf(data.user!.id);
    expect(created.role).toBe("guardian");
    expect(created.phone_verified_at).not.toBeNull();

    const unconfirmed = await makeUser("unconfirmed");
    expect((await roleOf(unconfirmed.id)).phone_verified_at).toBeNull();
    await db.auth.admin.updateUserById(unconfirmed.id, { phone: `9191${String(Date.now()).slice(-8)}`, phone_confirm: true });
    expect((await roleOf(unconfirmed.id)).phone_verified_at).not.toBeNull();
    await sql`update auth.users set phone = null, phone_confirmed_at = null where id = ${unconfirmed.id}`;
    expect((await roleOf(unconfirmed.id)).phone_verified_at).toBeNull();
  });

  it("a guardian cannot change their own role through the profile API or the database API", async () => {
    const guardian = await makeUser("self");
    session.user = { id: guardian.id };
    expect((await patchProfile({ role: "platform_admin" })).status).toBe(400);
    expect((await patchProfile({ display_name: "t019 Parent", role: "platform_admin" })).status).toBe(400);
    const ok = await patchProfile({ display_name: "t019 Parent" });
    expect(ok.status).toBe(200);
    expect((await ok.json()).profile).toMatchObject({ role: "guardian", display_name: "t019 Parent" });

    // Signed in with their own JWT (anon key + RLS): updates are not granted.
    const client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
      auth: { persistSession: false },
    });
    expect((await client.auth.signInWithPassword({ email: guardian.email, password: guardian.password })).error).toBeNull();
    await client.from("user_profiles").update({ role: "platform_admin" }).eq("id", guardian.id);
    await client.auth.updateUser({ data: { role: "platform_admin" } });
    expect((await roleOf(guardian.id)).role).toBe("guardian");

    const [event] = await sql<{ actor_user_id: string; details: { fields: string[] } }[]>`
      select actor_user_id, details from audit_events where action = 'guardian.profile_updated' and actor_user_id = ${guardian.id}`;
    expect(event.details).toEqual({ fields: ["display_name"] });
  });

  it("providers get 403 and anonymous callers 401 from the family profile API", async () => {
    const provider = await makeUser("p403", { app_metadata: { role: "provider" } });
    session.user = { id: provider.id };
    const res = await patchProfile({ display_name: "x" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Not allowed" });
    session.user = null;
    expect((await patchProfile({ display_name: "x" })).status).toBe(401);
  });
});
