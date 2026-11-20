// Ticket 054 FR-3 / FR-4 (database): a check-in started from a poster link stores the referring profile, resolved by the
// server from the slug (verified + listed only, SHOW_SYNTHETIC_LISTINGS as /p/<slug>); unknown, unlisted, malformed and
// client-supplied ids store nothing and never block the check-in; the poster count is an aggregate of the last 30 days;
// deleting a profile leaves the check-in unattributed. Needs the local Supabase stack (DATABASE_URL) with the 054
// migration applied; skipped when it is not set or SKIP_DB_TESTS=1. Synthetic data only.
import { randomUUID } from "node:crypto";
import { loadEnvConfig } from "@next/env";
import postgres, { type Sql } from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { screenReq } from "./helpers/screen";

vi.mock("next/cache", () => ({ revalidateTag: vi.fn(), unstable_cache: (fn: () => unknown) => fn }));

loadEnvConfig(process.cwd(), false, { info: () => {}, error: () => {} });
const enabled = Boolean(process.env.DATABASE_URL) && process.env.SKIP_DB_TESTS !== "1";

describe.skipIf(!enabled)("referral kit (database)", () => {
  let sql: Sql;
  const tag = randomUUID().slice(0, 8);
  const profiles: string[] = [];
  const sessions: string[] = [];
  let listed: { id: string; slug: string };
  let unlisted: { id: string; slug: string };
  let demo: { id: string; slug: string };

  async function profile(name: string, opts: { listed: boolean; synthetic?: boolean }) {
    const slug = `t054-${name}-${tag}`;
    const [row] = await sql<{ id: string }[]>`
      insert into provider_profiles (slug, display_name, provider_type, verification_status, verified_at, listed, is_synthetic)
      values (${slug}, ${`Dr ${name} (synthetic)`}, 'pediatrician', ${opts.listed ? "verified" : "pending"},
              ${opts.listed ? new Date() : null}, ${opts.listed}, ${opts.synthetic ?? false})
      returning id`;
    profiles.push(row.id);
    return { id: row.id, slug };
  }

  async function start(body: Record<string, unknown>) {
    const { POST } = await import("@/app/api/screen/sessions/route");
    const res = await POST(screenReq("/api/screen/sessions", { age_band: "31-71m", mode: "form", ...body }));
    const json = await res.json();
    if (res.status === 201) sessions.push(json.session_id);
    return { status: res.status, body: json };
  }

  const referredBy = async (id: string) =>
    (await sql<{ referred_by_profile_id: string | null }[]>`select referred_by_profile_id from screen_sessions where id = ${id}`)[0]
      ?.referred_by_profile_id ?? null;

  beforeAll(async () => {
    sql = postgres(process.env.DATABASE_URL as string, { max: 4, prepare: false, onnotice: () => {} });
    listed = await profile("listed", { listed: true });
    unlisted = await profile("unlisted", { listed: false });
    demo = await profile("demo", { listed: true, synthetic: true });
  });

  beforeEach(async () => (await import("@/lib/screen/rate-limit")).screenSessionLimiter.reset());
  afterEach(() => vi.unstubAllEnvs());

  afterAll(async () => {
    if (!sql) return;
    if (sessions.length) await sql`delete from screen_sessions where id in ${sql(sessions)}`;
    if (profiles.length) await sql`delete from provider_profiles where id in ${sql(profiles)}`;
    await sql.end({ timeout: 5 });
  });

  it("migration: nullable column with a foreign key to provider_profiles (on delete set null) and an index", async () => {
    const [col] = await sql`
      select is_nullable, data_type from information_schema.columns
      where table_schema = 'public' and table_name = 'screen_sessions' and column_name = 'referred_by_profile_id'`;
    expect(col).toMatchObject({ is_nullable: "YES", data_type: "uuid" });
    const [fk] = await sql`
      select confdeltype from pg_constraint
      where conrelid = 'public.screen_sessions'::regclass and contype = 'f'
        and confrelid = 'public.provider_profiles'::regclass`;
    expect(fk).toMatchObject({ confdeltype: "n" });
    const [idx] = await sql`select indexname from pg_indexes where tablename = 'screen_sessions' and indexname = 'screen_sessions_referred_by_idx'`;
    expect(idx).toBeTruthy();
  });

  it("a verified + listed slug is stored as the profile id; the response carries nothing extra", async () => {
    const { status, body } = await start({ ref: listed.slug });
    expect(status).toBe(201);
    expect(Object.keys(body).sort()).toEqual(["expires_at", "questions", "session_id"]);
    expect(await referredBy(body.session_id)).toBe(listed.id);
  });

  it.each([
    ["unlisted / pending profile", () => ({ ref: unlisted.slug })],
    ["unknown slug", () => ({ ref: `t054-nobody-${tag}` })],
    ["malformed slug", () => ({ ref: "Dr X'; drop table screen_sessions;--" })],
    ["not a string", () => ({ ref: 12345 })],
    ["a client-supplied profile id (never trusted)", () => ({ referred_by_profile_id: listed.id, ref: listed.id })],
  ])("%s: the check-in starts, nothing is stored", async (_label, body) => {
    const { status, body: res } = await start(body());
    expect(status).toBe(201);
    expect(await referredBy(res.session_id)).toBeNull();
  });

  it("demo profiles follow SHOW_SYNTHETIC_LISTINGS (as /p/<slug>)", async () => {
    vi.stubEnv("SHOW_SYNTHETIC_LISTINGS", "true");
    const shown = await start({ ref: demo.slug });
    expect(await referredBy(shown.body.session_id)).toBe(demo.id);
    vi.stubEnv("SHOW_SYNTHETIC_LISTINGS", "false");
    const hidden = await start({ ref: demo.slug });
    expect(hidden.status).toBe(201);
    expect(await referredBy(hidden.body.session_id)).toBeNull();
  });

  it("FR-4 count: check-ins from this poster in the last 30 days only", async () => {
    const { countReferredCheckins } = await import("@/lib/referrals");
    const fresh = await profile("count", { listed: true });
    expect(await countReferredCheckins(fresh.id)).toBe(0);
    await start({ ref: fresh.slug });
    await start({ ref: fresh.slug });
    const [old] = await sql<{ id: string }[]>`
      insert into screen_sessions (age_band, mode, referred_by_profile_id, created_at, expires_at)
      values ('31-71m', 'form', ${fresh.id}, now() - interval '31 days', now() - interval '31 days' + interval '2 hours')
      returning id`;
    sessions.push(old.id);
    expect(await countReferredCheckins(fresh.id)).toBe(2);
    expect(await countReferredCheckins(listed.id)).toBeGreaterThanOrEqual(1);
  });

  it("deleting the profile keeps the check-in, unattributed", async () => {
    const gone = await profile("gone", { listed: true });
    const { body } = await start({ ref: gone.slug });
    expect(await referredBy(body.session_id)).toBe(gone.id);
    await sql`delete from provider_profiles where id = ${gone.id}`;
    const [row] = await sql`select id, referred_by_profile_id from screen_sessions where id = ${body.session_id}`;
    expect(row).toMatchObject({ id: body.session_id, referred_by_profile_id: null });
  });
});
