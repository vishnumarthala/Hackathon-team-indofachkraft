// Ticket 029 FR-4: geocoding. Google Geocoding API calls are mocked at the fetch boundary (no key, no network);
// the bundled Hyderabad table answers DEMO_MODE / key-less setups. The DB part checks the failure path end to
// end: a location whose address cannot be placed is saved with null lat/lng and is not searchable.
import { loadEnvConfig } from "@next/env";
import postgres, { type Sql } from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { geocodeLocationFields, getGeocoder, googleGeocoder, lookupLocality, lookupPincode, tableGeocoder, type AddressInput } from "@/lib/geo/geocode";
import { jsonRequest, params, providerFixtures, type TestUser } from "./helpers/providers";
import { purgeTestAudit } from "./helpers/audit";

loadEnvConfig(process.cwd(), false, { info: () => {}, error: () => {} });
const enabled = Boolean(process.env.DATABASE_URL) && process.env.SKIP_DB_TESTS !== "1";

const session = vi.hoisted(() => ({ user: null as null | { id: string; email: string } }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getAuthenticatedUser: vi.fn(async () => session.user) };
});
vi.mock("next/cache", () => ({ revalidateTag: vi.fn(), unstable_cache: (fn: () => unknown) => fn }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ADDRESS: AddressInput = {
  address_line1: "1 Synthetic Road",
  address_line2: null,
  locality: "Banjara Hills",
  city: "Hyderabad",
  state: "Telangana",
  pincode: "500034",
};

const googleOk = (lat: number, lng: number) =>
  new Response(
    JSON.stringify({
      status: "OK",
      results: [
        {
          geometry: { location: { lat, lng } },
          address_components: [
            { long_name: "Banjara Hills", types: ["sublocality_level_1", "sublocality", "political"] },
            { long_name: "Hyderabad", types: ["locality", "political"] },
          ],
        },
      ],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );

describe("bundled Hyderabad table", () => {
  it("geocodes known PIN codes and localities", () => {
    expect(lookupPincode("500034")).toEqual({ lat: 17.4126, lng: 78.4482, locality: "Banjara Hills", source: "table" });
    expect(lookupPincode("500032")).toMatchObject({ locality: "Gachibowli" });
    expect(lookupLocality("Banjara Hills")).toMatchObject({ lat: 17.4126, lng: 78.4482 });
    expect(lookupLocality("  banjara hills, Hyderabad ")).toMatchObject({ locality: "Banjara Hills" });
    expect(lookupLocality("Road No. 12, Banjara Hills")).toMatchObject({ locality: "Banjara Hills" });
    expect(lookupLocality("HITEC City")).toMatchObject({ locality: "Hitech City" });
    expect(lookupLocality("Secunderabad")).toMatchObject({ locality: "Secunderabad" });
    expect(lookupLocality("near 500032")).toMatchObject({ locality: "Gachibowli" });
    expect(lookupLocality("gachi")).toMatchObject({ locality: "Gachibowli" });
  });

  it("returns null for unknown places", async () => {
    expect(lookupPincode("110001")).toBeNull();
    expect(lookupLocality("Atlantis")).toBeNull();
    expect(lookupLocality("")).toBeNull();
    expect(await tableGeocoder.geocodeAddress({ ...ADDRESS, pincode: "199999" })).toBeNull();
  });

  it("matches addresses by PIN code only (DEMO_MODE fixtures are keyed by PIN code)", async () => {
    expect(await tableGeocoder.geocodeAddress({ ...ADDRESS, locality: "Somewhere else" })).toMatchObject({ lat: 17.4126 });
    expect(await tableGeocoder.geocodeAddress({ ...ADDRESS, pincode: "199999", locality: "Banjara Hills" })).toBeNull();
  });
});

describe("Google geocoder (mocked fetch)", () => {
  it("sends the address with India and PIN code restrictions and reads the first result", async () => {
    const fetchMock = vi.fn(async () => googleOk(17.4127, 78.4481));
    const geo = googleGeocoder("server-key-for-tests", fetchMock as unknown as typeof fetch);
    expect(await geo.geocodeAddress(ADDRESS)).toEqual({ lat: 17.4127, lng: 78.4481, locality: "Banjara Hills", source: "google" });
    const url = new URL(String((fetchMock.mock.calls[0] as unknown[])[0]));
    expect(url.origin + url.pathname).toBe("https://maps.googleapis.com/maps/api/geocode/json");
    expect(url.searchParams.get("address")).toBe("1 Synthetic Road, Banjara Hills, Hyderabad, Telangana 500034");
    expect(url.searchParams.get("components")).toBe("country:IN|postal_code:500034");
    expect(url.searchParams.get("region")).toBe("in");
    expect(url.searchParams.get("key")).toBe("server-key-for-tests");
  });

  it.each([
    ["ZERO_RESULTS", () => new Response(JSON.stringify({ status: "ZERO_RESULTS", results: [] }), { status: 200 })],
    ["REQUEST_DENIED", () => new Response(JSON.stringify({ status: "REQUEST_DENIED" }), { status: 200 })],
    ["HTTP 500", () => new Response("oops", { status: 500 })],
    ["a result outside India", () => googleOk(51.5, -0.1)],
    ["a network error", () => {
      throw new TypeError("fetch failed");
    }],
  ])("returns null on %s", async (_label, respond) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const geo = googleGeocoder("server-key-for-tests", vi.fn(async () => respond()) as unknown as typeof fetch);
    expect(await geo.geocodeAddress(ADDRESS)).toBeNull();
  });

  it("never logs the key or the address", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const geo = googleGeocoder("server-key-for-tests", vi.fn(async () => new Response(JSON.stringify({ status: "OVER_QUERY_LIMIT" }))) as unknown as typeof fetch);
    await geo.geocodeAddress(ADDRESS);
    const logged = errors.mock.calls.flat().join(" ");
    expect(logged).toContain("OVER_QUERY_LIMIT");
    expect(logged).not.toContain("server-key-for-tests");
    expect(logged).not.toContain("Synthetic Road");
  });

  it("answers free-text searches from the table first, then Google", async () => {
    const fetchMock = vi.fn(async () => googleOk(17.45, 78.38));
    const geo = googleGeocoder("server-key-for-tests", fetchMock as unknown as typeof fetch);
    expect(await geo.geocodeQuery("Banjara Hills")).toMatchObject({ source: "table" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await geo.geocodeQuery("Synthetic Tech Park")).toMatchObject({ lat: 17.45, lng: 78.38, source: "google" });
    expect(new URL(String((fetchMock.mock.calls[0] as unknown[])[0])).searchParams.get("address")).toBe("Synthetic Tech Park, Hyderabad, Telangana");
  });
});

describe("geocoder selection", () => {
  it("uses the table in DEMO_MODE or without a server key, Google otherwise", async () => {
    const fetchMock = vi.fn(async () => googleOk(17.5, 78.5));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("GOOGLE_MAPS_SERVER_KEY", "server-key-for-tests");
    vi.stubEnv("DEMO_MODE", "true");
    expect(getGeocoder()).toBe(tableGeocoder);
    vi.stubEnv("DEMO_MODE", "false");
    vi.stubEnv("GOOGLE_MAPS_SERVER_KEY", "");
    expect(getGeocoder()).toBe(tableGeocoder);
    vi.stubEnv("GOOGLE_MAPS_SERVER_KEY", "server-key-for-tests");
    expect(await getGeocoder().geocodeAddress(ADDRESS)).toMatchObject({ lat: 17.5, source: "google" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe("geocodeLocationFields", () => {
  it("keeps trusted (admin) coordinates, otherwise geocodes the address and ignores client coordinates", async () => {
    const trusted = await geocodeLocationFields({ ...ADDRESS, lat: 17.1, lng: 78.1 }, { trustCoordinates: true, geocoder: tableGeocoder });
    expect(trusted).toMatchObject({ geocoded: true, fields: { lat: 17.1, lng: 78.1 } });
    const untrusted = await geocodeLocationFields({ ...ADDRESS, lat: 51.5, lng: -0.1 }, { trustCoordinates: false, geocoder: tableGeocoder });
    expect(untrusted).toMatchObject({ geocoded: true, fields: { lat: 17.4126, lng: 78.4482 } });
  });

  it("failure: saved without coordinates", async () => {
    const failed = await geocodeLocationFields({ ...ADDRESS, pincode: "199999" }, { trustCoordinates: false, geocoder: tableGeocoder });
    expect(failed).toEqual({ geocoded: false, fields: { ...ADDRESS, pincode: "199999", lat: null, lng: null } });
  });
});

describe.skipIf(!enabled)("location geocoding through the APIs (database)", { timeout: 60_000 }, () => {
  let sql: Sql;
  let db: ReturnType<typeof import("@/lib/db").supabaseAdmin>;
  const fx = providerFixtures("t029g", () => db, () => sql);
  let provider: TestUser;
  let admin: TestUser;
  let profileId: string;
  let orgId: string;

  beforeAll(async () => {
    sql = postgres(process.env.DATABASE_URL as string, { max: 4, prepare: false, onnotice: () => {} });
    db = (await import("@/lib/db")).supabaseAdmin();
    admin = await fx.makeUser("admin", "platform_admin");
    provider = await fx.makeUser("provider");
    session.user = provider;
    const { POST } = await import("@/app/api/providers/register/route");
    const res = await POST(jsonRequest("/api/providers/register", "POST", { provider_type: "speech_language_pathologist", full_name: `t029 ${fx.tag} Geo (synthetic)` }));
    expect(res.status).toBe(201);
    profileId = ((await res.json()) as { profile_id: string }).profile_id;
    [{ org_id: orgId }] = await sql<{ org_id: string }[]>`select org_id from org_members where user_id = ${provider.id}`;
  });

  afterAll(async () => {
    session.user = null;
    if (orgId) await purgeTestAudit(sql, (tx) => tx`delete from audit_events where action = 'org.location_created' and details ->> 'org_id' = ${orgId}`);
    await fx.cleanup();
    await sql.end({ timeout: 5 });
  });

  const addLocation = async (body: Record<string, unknown>) => {
    session.user = provider;
    const { POST } = await import("@/app/api/providers/[id]/locations/route");
    return POST(jsonRequest(`/api/providers/${profileId}/locations`, "POST", body), params({ id: profileId }));
  };
  const base = { name: "Synthetic branch", address_line1: "1 Synthetic Road", locality: "Banjara Hills", city: "Hyderabad", state: "Telangana" };

  it("geocodes a new provider location server-side (client lat/lng ignored)", async () => {
    vi.stubEnv("DEMO_MODE", "true");
    const res = await addLocation({ ...base, org_id: orgId, pincode: "500034", lat: 51.5, lng: -0.1 });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { location: { id: string; lat: number; lng: number }; geocoded: boolean };
    expect(body.geocoded).toBe(true);
    expect(body.location).toMatchObject({ lat: 17.4126, lng: 78.4482 });
    const [row] = await sql`select geog is not null as searchable from practice_locations where id = ${body.location.id}`;
    expect(row.searchable).toBe(true);
  });

  it("failure path: saved with null lat/lng, geocoded false, not searchable", async () => {
    vi.stubEnv("DEMO_MODE", "true");
    const res = await addLocation({ ...base, org_id: orgId, pincode: "199999" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { location: { id: string; lat: number | null; lng: number | null }; geocoded: boolean };
    expect(body).toMatchObject({ geocoded: false, location: { lat: null, lng: null } });
    const [row] = await sql`select geog from practice_locations where id = ${body.location.id}`;
    expect(row.geog).toBeNull();
    const [audit] = await sql`select details from audit_events where entity_id = ${body.location.id} and action = 'org.location_created'`;
    expect(audit.details).toMatchObject({ geocoded: false });
  });

  it("the owner sets consultation modes (privileged fields still ignored)", async () => {
    session.user = provider;
    const { PATCH } = await import("@/app/api/providers/[id]/route");
    const res = await PATCH(jsonRequest(`/api/providers/${profileId}`, "PATCH", { offers_video: true, offers_in_clinic: false, listed: true }), params({ id: profileId }));
    expect(res.status).toBe(200);
    expect((await sql`select offers_video, offers_in_clinic, listed from provider_profiles where id = ${profileId}`)[0]).toEqual({
      offers_video: true,
      offers_in_clinic: false,
      listed: false,
    });
    const bad = await PATCH(jsonRequest(`/api/providers/${profileId}`, "PATCH", { offers_video: "yes" }), params({ id: profileId }));
    expect(bad.status).toBe(400);
  });

  it("admin seeding geocodes a location without coordinates and keeps given ones", async () => {
    vi.stubEnv("DEMO_MODE", "true");
    session.user = admin;
    const { POST } = await import("@/app/api/admin/providers/route");
    const seedBody = (key: string, location: Record<string, unknown>) => ({
      org_name: `t029 ${fx.tag} ${key} Synthetic Clinic`,
      location: { name: "Main", address_line1: "1 Synthetic Road", locality: "Gachibowli", ...location },
      display_name: `t029 ${fx.tag} ${key} (synthetic)`,
      provider_type: "occupational_therapist",
    });
    const geocoded = await POST(jsonRequest("/api/admin/providers", "POST", seedBody("auto", { pincode: "500032" })));
    expect(geocoded.status).toBe(201);
    const a = (await geocoded.json()) as { location_id: string; geocoded: boolean };
    expect(a.geocoded).toBe(true);
    expect((await sql`select lat::float8, lng::float8 from practice_locations where id = ${a.location_id}`)[0]).toEqual({ lat: 17.4401, lng: 78.3489 });

    const given = await POST(jsonRequest("/api/admin/providers", "POST", seedBody("given", { pincode: "199999", lat: 17.4, lng: 78.4 })));
    const b = (await given.json()) as { location_id: string; geocoded: boolean };
    expect(b.geocoded).toBe(true);
    expect((await sql`select lat::float8, lng::float8 from practice_locations where id = ${b.location_id}`)[0]).toEqual({ lat: 17.4, lng: 78.4 });

    const failed = await POST(jsonRequest("/api/admin/providers", "POST", seedBody("failed", { pincode: "199999" })));
    const c = (await failed.json()) as { location_id: string; geocoded: boolean };
    expect(c.geocoded).toBe(false);
    expect((await sql`select lat, geog from practice_locations where id = ${c.location_id}`)[0]).toEqual({ lat: null, geog: null });
  });
});
