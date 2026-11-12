// Ticket 029: PostGIS directory search - distance ordering, radius, type/language/mode filters, video-only
// providers, exclusion of unverified/unlisted/null-geo (and demo profiles when SHOW_SYNTHETIC_LISTINGS=false),
// one row per multi-location profile, the public API contract (400/422/429, caching) and pure helpers.
// DB parts run against the configured local Supabase (skipped without DATABASE_URL or with SKIP_DB_TESTS=1).
// Synthetic clinics and coordinates only.
import { loadEnvConfig } from "@next/env";
import postgres, { type Sql } from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { clusterPoints } from "@/lib/geo/cluster";
import { directionsUrl, findHref, isInIndia, OUTSIDE_AREA_ERROR, roundCoord, staticMapUrl, typeFromSlug, typeSlug, DIRECTORY_TYPES } from "@/lib/geo/constants";
import { parseSearchQuery } from "@/lib/geo/params";
import { createRateLimiter } from "@/lib/geo/rate-limit";
import type { DirectoryResult } from "@/lib/geo/search";
import { jsonRequest, providerFixtures, type TestUser } from "./helpers/providers";

loadEnvConfig(process.cwd(), false, { info: () => {}, error: () => {} });
const enabled = Boolean(process.env.DATABASE_URL) && process.env.SKIP_DB_TESTS !== "1";

const session = vi.hoisted(() => ({ user: null as null | { id: string; email: string } }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getAuthenticatedUser: vi.fn(async () => session.user) };
});
vi.mock("next/cache", () => ({ revalidateTag: vi.fn(), unstable_cache: (fn: () => unknown) => fn }));

afterEach(() => vi.unstubAllEnvs());

describe("search parameters (pure)", () => {
  it("accepts a full query and applies defaults; blank form fields count as unset", () => {
    const ok = parseSearchQuery(new URLSearchParams("lat=17.4126&lng=78.4482&type=&language=&mode=&radius_km="));
    expect(ok.success && ok.data).toEqual({ lat: 17.4126, lng: 78.4482, radius_km: 10, mode: "any", page: 1 });
    const full = parseSearchQuery({ lat: "17.4", lng: "78.4", radius_km: "25", type: "centre", language: "te", mode: "video", page: "2", q: " Banjara Hills " });
    expect(full.success && full.data).toMatchObject({ radius_km: 25, type: "centre", language: "te", mode: "video", page: 2, q: "Banjara Hills" });
  });

  it.each([
    ["radius below 1", "lat=17.4&lng=78.4&radius_km=0"],
    ["radius above 50", "lat=17.4&lng=78.4&radius_km=51"],
    ["fractional radius", "lat=17.4&lng=78.4&radius_km=2.5"],
    ["unknown mode", "lat=17.4&lng=78.4&mode=home"],
    ["unknown type", "lat=17.4&lng=78.4&type=surgeon"],
    ["unknown language", "lat=17.4&lng=78.4&language=fr"],
    ["lat without lng", "lat=17.4"],
    ["non-numeric lat", "lat=abc&lng=78.4"],
    ["lat out of range", "lat=91&lng=78.4"],
    ["page 0", "lat=17.4&lng=78.4&page=0"],
  ])("rejects %s", (_label, qs) => {
    expect(parseSearchQuery(new URLSearchParams(qs)).success).toBe(false);
  });

  it("checks the India bounding box", () => {
    expect(isInIndia(17.4126, 78.4482)).toBe(true);
    expect(isInIndia(51.5, -0.1)).toBe(false);
    expect(isInIndia(40.7, 74)).toBe(false);
  });
});

describe("URL helpers (pure)", () => {
  it("builds shareable /find URLs with rounded coordinates and without defaults", () => {
    expect(findHref({})).toBe("/find");
    expect(findHref({ lat: 17.412_634, lng: 78.448_219, radius_km: 10, mode: "any", page: 1 })).toBe("/find?lat=17.413&lng=78.448");
    expect(findHref({ q: "Banjara Hills", type: "speech_language_pathologist", language: "te", mode: "video", radius_km: 25, page: 2 })).toBe(
      "/find?q=Banjara+Hills&radius_km=25&type=speech_language_pathologist&language=te&mode=video&page=2",
    );
    expect(roundCoord(17.41264)).toBe(17.413);
  });

  it("maps every directory type to an SEO slug and back", () => {
    for (const type of DIRECTORY_TYPES) expect(typeFromSlug(typeSlug(type))).toBe(type);
    expect(typeSlug("speech_language_pathologist")).toBe("speech-language-pathologist");
    expect(typeSlug("centre")).toBe("centres");
    expect(typeFromSlug("surgeons")).toBeNull();
  });

  it("builds the directions and static map URLs", () => {
    expect(directionsUrl(17.4126, 78.4482)).toBe("https://www.google.com/maps/dir/?api=1&destination=17.4126,78.4482");
    const url = new URL(staticMapUrl([{ lat: 17.4126, lng: 78.4482 }], "browser-key"));
    expect(url.origin + url.pathname).toBe("https://maps.googleapis.com/maps/api/staticmap");
    expect(url.searchParams.get("markers")).toBe("color:0x0f766e|17.4126,78.4482");
    expect(url.searchParams.get("key")).toBe("browser-key");
  });
});

describe("map clustering (pure)", () => {
  const points = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, lat: 17.41 + (i % 5) * 0.0001, lng: 78.44 + i * 0.00001 }));

  it("keeps one marker per result up to 30 results", () => {
    const clusters = clusterPoints(points(30), 12);
    expect(clusters).toHaveLength(30);
    expect(clusters.every((c) => c.items.length === 1)).toBe(true);
  });

  it("clusters nearby markers above 30 results and separates them when zoomed in", () => {
    const pts = [...points(31), { id: "far", lat: 17.5, lng: 78.6 }];
    const zoomedOut = clusterPoints(pts, 10);
    expect(zoomedOut.length).toBeLessThan(pts.length);
    expect(zoomedOut.reduce((n, c) => n + c.items.length, 0)).toBe(pts.length);
    expect(zoomedOut.find((c) => c.items.some((p) => p.id === "far"))?.items).toHaveLength(1);
    expect(clusterPoints(pts, 21).length).toBeGreaterThan(zoomedOut.length);
  });
});

describe("rate limiter (pure)", () => {
  it("allows 60 requests per minute per key", () => {
    const limiter = createRateLimiter({ limit: 60, windowMs: 60_000 });
    for (let i = 0; i < 60; i++) expect(limiter.allow("1.2.3.4", 1_000 + i)).toBe(true);
    expect(limiter.allow("1.2.3.4", 2_000)).toBe(false);
    expect(limiter.allow("5.6.7.8", 2_000)).toBe(true);
    expect(limiter.allow("1.2.3.4", 61_001)).toBe(true);
  });
});

// Synthetic coordinates (eval.md): Banjara Hills, Gachibowli (~11 km away), Secunderabad, Jubilee Hills, Kompally.
const BANJARA = { lat: 17.4126, lng: 78.4482 };
const GACHIBOWLI = { lat: 17.4401, lng: 78.3489 };
const SECUNDERABAD = { lat: 17.4399, lng: 78.4983 };
const JUBILEE = { lat: 17.4325, lng: 78.4073 };
const KOMPALLY = { lat: 17.535, lng: 78.484 };

describe.skipIf(!enabled)("directory search (database)", { timeout: 90_000 }, () => {
  let sql: Sql;
  let db: ReturnType<typeof import("@/lib/db").supabaseAdmin>;
  const fx = providerFixtures("t029d", () => db, () => sql);
  let admin: TestUser;
  const ids: Record<string, string> = {};
  const locations: Record<string, string> = {};

  async function seed(
    key: string,
    opts: { type: string; at: { lat: number; lng: number } | null; pincode?: string; kind?: "centre" | "solo"; languages?: string[]; verified?: boolean; synthetic?: boolean; video?: boolean; clinic?: boolean },
  ) {
    const { POST } = await import("@/app/api/admin/providers/route");
    session.user = admin;
    const res = await POST(
      jsonRequest("/api/admin/providers", "POST", {
        org_name: `t029 ${fx.tag} ${key} Synthetic Clinic`,
        org_kind: opts.kind ?? "solo",
        location: {
          name: `${key} branch`,
          address_line1: "1 Synthetic Road",
          locality: key,
          pincode: opts.pincode ?? "500034",
          lat: opts.at?.lat ?? null,
          lng: opts.at?.lng ?? null,
        },
        display_name: `t029 ${fx.tag} ${key} (synthetic)`,
        provider_type: opts.type,
        languages: opts.languages ?? ["en"],
        registration_council: "RCI",
        registration_number: `TEST-${fx.tag}-${key}`,
        verified: opts.verified ?? true,
        is_synthetic: opts.synthetic ?? false,
        offers_video: opts.video ?? false,
        offers_in_clinic: opts.clinic ?? true,
      }),
    );
    session.user = null;
    expect(res.status, key).toBe(201);
    const body = (await res.json()) as { profile_id: string; location_id: string };
    ids[key] = body.profile_id;
    locations[key] = body.location_id;
  }

  beforeAll(async () => {
    sql = postgres(process.env.DATABASE_URL as string, { max: 4, prepare: false, onnotice: () => {} });
    db = (await import("@/lib/db")).supabaseAdmin();
    admin = await fx.makeUser("admin", "platform_admin");

    await seed("BanjaraSLP", { type: "speech_language_pathologist", at: BANJARA, kind: "centre", languages: ["te", "en"] });
    await seed("BanjaraOT", { type: "occupational_therapist", at: { lat: 17.4152, lng: 78.4503 }, languages: ["hi", "en"], video: true });
    await seed("GachibowliSLP", { type: "speech_language_pathologist", at: GACHIBOWLI, pincode: "500032", languages: ["te"] });
    await seed("TwoSites", { type: "child_psychologist", at: SECUNDERABAD, pincode: "500003" });
    await seed("Unverified", { type: "speech_language_pathologist", at: BANJARA, verified: false });
    await seed("Unlisted", { type: "speech_language_pathologist", at: BANJARA });
    await seed("VideoOnly", { type: "speech_language_pathologist", at: KOMPALLY, pincode: "500014", languages: ["te"], video: true, clinic: false });
    await seed("Demo", { type: "speech_language_pathologist", at: { lat: 17.4131, lng: 78.4488 }, synthetic: true });
    // Unknown PIN code and no coordinates: saved without geo, never searchable.
    await seed("NoGeo", { type: "speech_language_pathologist", at: null, pincode: "199999" });

    await sql`update provider_profiles set listed = false where id = ${ids.Unlisted}`;
    // Second location for TwoSites (Jubilee Hills, nearer to Banjara Hills than Secunderabad).
    const [org] = await sql<{ org_id: string }[]>`select org_id from practice_locations where id = ${locations.TwoSites}`;
    const [loc] = await sql<{ id: string }[]>`
      insert into practice_locations (org_id, name, address_line1, locality, pincode, lat, lng)
      values (${org.org_id}, 'Jubilee branch', '2 Synthetic Road', 'Jubilee Hills', '500033', ${JUBILEE.lat}, ${JUBILEE.lng}) returning id`;
    locations.TwoSitesJubilee = loc.id;
    await sql`insert into provider_locations (provider_profile_id, location_id, org_id) values (${ids.TwoSites}, ${loc.id}, ${org.org_id})`;
  });

  afterAll(async () => {
    await fx.cleanup();
    await sql.end({ timeout: 5 });
  });

  const ours = (rows: DirectoryResult[]) => {
    const mine = new Set(Object.values(ids));
    return rows.filter((r) => mine.has(r.profile_id));
  };
  const keyOf = (id: string) => Object.entries(ids).find(([, v]) => v === id)?.[0];
  const keys = (rows: DirectoryResult[]) => ours(rows).map((r) => keyOf(r.profile_id));

  async function search(params: Record<string, unknown>, includeSynthetic = true): Promise<DirectoryResult[]> {
    const rows = await sql<DirectoryResult[]>`
      select * from search_providers(
        ${BANJARA.lat}, ${BANJARA.lng}, ${(params.radius as number) ?? 10}, ${(params.types as string[]) ?? null},
        ${(params.language as string) ?? null}, ${(params.mode as string) ?? "any"}, 100, 0, ${includeSynthetic})`;
    return rows.map((r) => ({ ...r, distance_km: r.distance_km === null ? null : Number(r.distance_km) }));
  }

  it("maintains geog from lat/lng and leaves null-geo locations out", async () => {
    const [row] = await sql`select geog is not null as has_geog, round(extensions.st_y(geog::extensions.geometry)::numeric, 4)::float8 as lat from practice_locations where id = ${locations.BanjaraSLP}`;
    expect(row).toEqual({ has_geog: true, lat: 17.4126 });
    const [noGeo] = await sql`select lat, lng, geog from practice_locations where id = ${locations.NoGeo}`;
    expect(noGeo).toEqual({ lat: null, lng: null, geog: null });
    await sql`update practice_locations set lat = 17.4, lng = 78.45 where id = ${locations.NoGeo}`;
    expect((await sql`select geog is not null as g from practice_locations where id = ${locations.NoGeo}`)[0].g).toBe(true);
    await sql`update practice_locations set lat = null, lng = null where id = ${locations.NoGeo}`;
    expect((await sql`select geog is null as g from practice_locations where id = ${locations.NoGeo}`)[0].g).toBe(true);
  });

  it("orders by distance; excludes unverified, unlisted and null-geo profiles; radius filters", async () => {
    const near = await search({ radius: 5 });
    const k = keys(near);
    expect(k[0]).toBe("BanjaraSLP");
    expect(k).toEqual(expect.arrayContaining(["BanjaraSLP", "Demo", "BanjaraOT"]));
    expect(k).not.toContain("GachibowliSLP");
    for (const hidden of ["Unverified", "Unlisted", "NoGeo", "VideoOnly"]) expect(k).not.toContain(hidden);
    const dists = ours(near).map((r) => r.distance_km as number);
    expect(dists).toEqual([...dists].sort((a, b) => a - b));
    expect(ours(near)[0].distance_km).toBe(0);

    expect(keys(await search({ radius: 10 }))).not.toContain("GachibowliSLP");
    const wide = ours(await search({ radius: 25 }));
    const gachi = wide.find((r) => r.profile_id === ids.GachibowliSLP);
    expect(gachi?.distance_km).toBeGreaterThan(10);
    expect(gachi?.distance_km).toBeLessThan(12);
    expect(gachi).toMatchObject({ locality: "GachibowliSLP", lat: GACHIBOWLI.lat, lng: GACHIBOWLI.lng, rating_avg: null, rating_count: null });
  });

  it("returns one row per profile, at its nearest location", async () => {
    const rows = ours(await search({ radius: 25 })).filter((r) => r.profile_id === ids.TwoSites);
    expect(rows).toHaveLength(1);
    expect(rows[0].location_id).toBe(locations.TwoSitesJubilee);
    expect(rows[0].locality).toBe("Jubilee Hills");
  });

  it("filters by type (incl. centres) and language", async () => {
    // 12 km: Gachibowli (~11 km) is in, the Kompally video-only provider (~14 km) is out.
    expect(keys(await search({ radius: 12, types: ["speech_language_pathologist"] })).sort()).toEqual(["BanjaraSLP", "Demo", "GachibowliSLP"]);
    expect(keys(await search({ radius: 25, types: ["centre"] }))).toEqual(["BanjaraSLP"]);
    expect(keys(await search({ radius: 12, language: "te" })).sort()).toEqual(["BanjaraSLP", "GachibowliSLP"]);
    expect(keys(await search({ radius: 12, types: ["speech_language_pathologist"], language: "te" })).sort()).toEqual(["BanjaraSLP", "GachibowliSLP"]);
    // Within 25 km a provider offering video (and nothing in clinic) is still a nearby result in mode "any".
    expect(keys(await search({ radius: 25, types: ["speech_language_pathologist"], language: "te" })).sort()).toEqual(["BanjaraSLP", "GachibowliSLP", "VideoOnly"]);
    const centre = ours(await search({ radius: 5, types: ["centre"] }))[0];
    expect(centre).toMatchObject({ org_kind: "centre", org_public_name: `t029 ${fx.tag} BanjaraSLP Synthetic Clinic` });
  });

  it("mode: in_clinic excludes video-only; video adds video-only providers regardless of distance, by name", async () => {
    const clinic = keys(await search({ radius: 25, mode: "in_clinic" }));
    expect(clinic).not.toContain("VideoOnly");
    expect(clinic).toContain("BanjaraSLP");

    const video = ours(await search({ radius: 2, mode: "video" }));
    expect(video.map((r) => keyOf(r.profile_id))).toEqual(["BanjaraOT", "VideoOnly"]);
    expect(video[0].distance_km).not.toBeNull();
    expect(video[1]).toMatchObject({ distance_km: null, offers_video: true, offers_in_clinic: false, lat: null, lng: null });

    expect(keys(await search({ radius: 5, mode: "any" }))).not.toContain("VideoOnly");
    expect(keys(await search({ radius: 25, mode: "video", language: "hi" }))).toEqual(["BanjaraOT"]);
  });

  it("includes demo profiles with is_synthetic unless they are switched off", async () => {
    const demo = ours(await search({ radius: 5 })).find((r) => r.profile_id === ids.Demo);
    expect(demo?.is_synthetic).toBe(true);
    expect(keys(await search({ radius: 5 }, false))).not.toContain("Demo");
  });

  it("rejects invalid coordinates and modes in SQL; clamps radius and limit", async () => {
    await expect(sql`select * from search_providers(null, 78.4)`).rejects.toThrow(/invalid coordinates/);
    await expect(sql`select * from search_providers(17.4, 78.4, 10, null, null, 'home')`).rejects.toThrow(/invalid mode/);
    const clamped = ours(await sql<DirectoryResult[]>`select * from search_providers(${BANJARA.lat}, ${BANJARA.lng}, 500, null, null, 'any', 1000, 0)`);
    expect(clamped.map((r) => r.profile_id)).toContain(ids.GachibowliSLP);
  });

  it("is executable by the service role only", async () => {
    const [grants] = await sql`
      select has_function_privilege('anon', 'public.search_providers(float8, float8, int, text[], text, text, int, int, boolean)', 'execute') as anon,
             has_function_privilege('authenticated', 'public.search_providers(float8, float8, int, text[], text, text, int, int, boolean)', 'execute') as authed,
             has_function_privilege('service_role', 'public.search_providers(float8, float8, int, text[], text, text, int, int, boolean)', 'execute') as service`;
    expect(grants).toEqual({ anon: false, authed: false, service: true });
  });

  describe("GET /api/public/providers", () => {
    const get = async (qs: string, ip = `10.29.0.${Math.floor(Math.random() * 250)}`) => {
      const { GET } = await import("@/app/api/public/providers/route");
      return GET(new Request(`http://localhost/api/public/providers?${qs}`, { headers: { "x-forwarded-for": ip } }));
    };

    it("200 with results, page, has_more and a public s-maxage cache header", async () => {
      const res = await get(`lat=${BANJARA.lat}&lng=${BANJARA.lng}&radius_km=5&type=speech_language_pathologist&language=te`);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("public, s-maxage=60");
      const body = (await res.json()) as { results: DirectoryResult[]; page: number; has_more: boolean };
      expect(body.page).toBe(1);
      expect(typeof body.has_more).toBe("boolean");
      expect(keys(body.results)).toEqual(["BanjaraSLP"]);
      const card = ours(body.results)[0];
      expect(Object.keys(card).sort()).toEqual(
        [
          "profile_id", "slug", "display_name", "provider_type", "languages", "location_id", "locality", "distance_km", "org_public_name",
          "org_kind", "org_slug", "offers_video", "offers_in_clinic", "rating_avg", "rating_count", "is_synthetic", "lat", "lng",
        ].sort(),
      );
      expect(JSON.stringify(body)).not.toMatch(/TEST-|registration|user_id|verification_note|@example\.com/);
    });

    it("paginates", async () => {
      const { searchProviders } = await import("@/lib/geo/search");
      const first = await searchProviders({ ...BANJARA, radiusKm: 5, mode: "any", page: 1, pageSize: 1 });
      expect(first.results).toHaveLength(1);
      expect(first.has_more).toBe(true);
      const second = await searchProviders({ ...BANJARA, radiusKm: 5, mode: "any", page: 2, pageSize: 1 });
      expect(second.page).toBe(2);
      expect(second.results[0].profile_id).not.toBe(first.results[0].profile_id);
    });

    it("hides demo profiles when SHOW_SYNTHETIC_LISTINGS=false", async () => {
      vi.stubEnv("SHOW_SYNTHETIC_LISTINGS", "false");
      const body = (await (await get(`lat=${BANJARA.lat}&lng=${BANJARA.lng}&radius_km=5`)).json()) as { results: DirectoryResult[] };
      expect(keys(body.results)).not.toContain("Demo");
      expect(keys(body.results)).toContain("BanjaraSLP");
    });

    it("400 for invalid parameters, 422 outside India", async () => {
      for (const qs of ["", "lat=17.4", "lat=17.4&lng=78.4&radius_km=0", "lat=17.4&lng=78.4&mode=home", "lat=x&lng=78.4", "lat=17.4&lng=78.4&type=surgeon"]) {
        const res = await get(qs);
        expect(res.status, qs).toBe(400);
        expect(((await res.json()) as { error: string }).error).toBe("Invalid request");
      }
      const london = await get("lat=51.5&lng=-0.1");
      expect(london.status).toBe(422);
      expect(await london.json()).toEqual({ error: OUTSIDE_AREA_ERROR });
      expect(OUTSIDE_AREA_ERROR).toBe("We currently list providers in Hyderabad only");
    });

    it("429 on the 61st request within a minute from one IP", async () => {
      const ip = "10.29.1.1";
      for (let i = 0; i < 60; i++) expect((await get("lat=51.5&lng=-0.1", ip)).status).toBe(422);
      const limited = await get(`lat=${BANJARA.lat}&lng=${BANJARA.lng}`, ip);
      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).toBe("60");
      expect((await get(`lat=${BANJARA.lat}&lng=${BANJARA.lng}`, "10.29.1.2")).status).toBe(200);
    });

    it("is public (no session needed) in the proxy rules", async () => {
      const { isProtectedPath } = await import("@/lib/auth-access");
      expect(isProtectedPath("/api/public/providers")).toBe(false);
      expect(isProtectedPath("/find")).toBe(false);
      expect(isProtectedPath("/find/hyderabad/centres")).toBe(false);
    });
  });
});
