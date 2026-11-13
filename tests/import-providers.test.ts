// Ticket 042 FR-4: real-provider CSV import. Unit: CSV parsing, validation with row numbers (bad PIN code, unknown
// provider type, all or nothing). Database: invalid file -> nothing written; dry run -> nothing written; real run ->
// unclaimed, unverified, unlisted, non-synthetic profiles (centre rows share one organisation), geocoded via 029's
// table, claim links printed (not stored, not written to disk) and working with 028's claim flow. Synthetic CSVs in
// tests/fixtures/import; skipped without DATABASE_URL.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { loadEnvConfig } from "@next/env";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { tableGeocoder } from "@/lib/geo/geocode";
import { formatErrors, parseCsv, runImport, validateCsv } from "@/scripts/import-providers";
import { purgeTestAudit } from "./helpers/audit";
import { createWorld } from "./helpers/world";

loadEnvConfig(process.cwd(), false, { info: () => {}, error: () => {} });
const enabled = Boolean(process.env.DATABASE_URL) && process.env.SKIP_DB_TESTS !== "1";

vi.mock("next/cache", () => ({ revalidateTag: vi.fn(), unstable_cache: (fn: () => unknown) => fn }));

const FIXTURES = path.join(process.cwd(), "tests/fixtures/import");
const VALID = readFileSync(path.join(FIXTURES, "valid.csv"), "utf8");
const INVALID = readFileSync(path.join(FIXTURES, "invalid.csv"), "utf8");
const HEADER = "display_name,provider_type,org_name,org_kind,address_line1,locality,pincode,phone_public,languages,website";

describe("CSV parsing and validation", () => {
  it("parses quoted fields, escaped quotes, CRLF, a BOM and blank lines", () => {
    expect(parseCsv('\uFEFFa,b\r\n"x, y","say ""hi"""\r\n\r\nz,\n')).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"'],
      ["z", ""],
    ]);
    expect(() => parseCsv('a\n"open')).toThrow(/unclosed quote/);
  });

  it("accepts the valid fixture", () => {
    const { rows, errors } = validateCsv(VALID);
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(3);
    expect(rows[1]).toMatchObject({ row: 3, provider_type: "speech_language_pathologist", org_kind: "centre", languages: ["en", "hi"], phone_public: null });
  });

  it("reports every bad row with its row number and column", () => {
    const { errors } = validateCsv(INVALID);
    expect(formatErrors(errors)).toEqual([
      "Row 3, pincode: Enter a 6-digit PIN code",
      expect.stringMatching(/^Row 4, provider_type: Unknown provider type "astrologer"/),
    ]);
    const more = validateCsv(
      [
        HEADER,
        "C (synthetic),pediatrician,,solo,Plot 1,Ameerpet,500016,123,en;xx,ftp://x",
        "B (synthetic),pediatrician,B clinic,franchise,Plot 1,Ameerpet,500016,,en,",
        "A (synthetic),pediatrician,A clinic,solo,Plot 1,Ameerpet,500016,,en,",
        "A (synthetic),pediatrician,A clinic,solo,Plot 1,Ameerpet,500016,,en,",
        "too,few",
      ].join("\n"),
    ).errors;
    const text = formatErrors(more).join("\n");
    expect(text).toMatch(/Row 2, languages: Unknown language code\(s\): xx/);
    expect(text).toMatch(/Row 2, phone_public: Enter a valid phone number/);
    expect(text).toMatch(/Row 2, website: Enter a full web address/);
    expect(text).toMatch(/Row 2, org_name: Organisation name is required/);
    expect(text).toMatch(/Row 3, org_kind: Use centre or solo/);
    expect(text).toMatch(/Row 5, display_name: Same provider and PIN code as row 4/);
    expect(text).toMatch(/Row 6: Expected 10 values, found 2/);
    expect(validateCsv("name,type\nx,y").errors[0].message).toMatch(/Missing column/);
  });
});

/** Every file under `dir` with its size and modification time (to prove nothing was written). */
function snapshot(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (["node_modules", ".git", ".next"].includes(entry.name)) continue;
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else {
        const s = statSync(p);
        out.push(`${p}:${s.size}:${s.mtimeMs}`);
      }
    }
  };
  walk(dir);
  return out.sort();
}

describe.skipIf(!enabled)("import:providers against the database (FR-4, E-4)", { timeout: 120_000 }, () => {
  let sql: Sql;
  let world: ReturnType<typeof createWorld>;
  const APP = "http://localhost:3999";
  const NAMES = ["Dr. Synthetic Import One", "Synthetic Import Two", "Synthetic Import Three", "Dr. Synthetic Valid Row"];
  const profilesByName = () =>
    sql<{ id: string; org_id: string; verification_status: string; listed: boolean; claimed: boolean; is_synthetic: boolean; user_id: string | null; lat: string | null; locality: string; kind: string }[]>`
      select p.id, pl.org_id, p.verification_status, p.listed, p.claimed, p.is_synthetic, p.user_id, l.lat, l.locality, o.kind
      from provider_profiles p join provider_locations pl on pl.provider_profile_id = p.id
      join practice_locations l on l.id = pl.location_id join organizations o on o.id = pl.org_id
      where p.display_name in ${sql(NAMES)} order by p.display_name`;

  async function cleanup() {
    const rows = await profilesByName();
    if (!rows.length) return;
    const ids = rows.map((r) => r.id);
    const orgs = [...new Set(rows.map((r) => r.org_id))];
    await sql`delete from outbox_events where aggregate_type = 'provider_profile' and aggregate_id in ${sql(ids)}`;
    await purgeTestAudit(sql, (tx) => tx`delete from audit_events where entity = 'provider_profile' and entity_id in ${tx(ids)}`);
    await sql`delete from provider_profiles where id in ${sql(ids)}`;
    await sql`delete from org_members where org_id in ${sql(orgs)}`;
    await sql`delete from organizations where id in ${sql(orgs)}`;
  }

  beforeAll(async () => {
    sql = postgres(process.env.DATABASE_URL as string, { max: 2, prepare: false, onnotice: () => {} });
    world = createWorld(sql, (await import("@/lib/db")).supabaseAdmin(), "t042i");
    await cleanup();
  });

  afterAll(async () => {
    if (sql) {
      await cleanup();
      await world.cleanup();
      await sql.end({ timeout: 5 });
    }
  });

  it("invalid file: errors with row numbers, nothing imported (even the valid row)", async () => {
    const out: string[] = [];
    const result = await runImport({ csv: INVALID, dryRun: false, sql, appUrl: APP, geocoder: tableGeocoder, out: (l) => out.push(l) });
    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.row)).toEqual([3, 4]);
    expect(out).toEqual([]);
    expect(await profilesByName()).toEqual([]);
  });

  it("dry run prints what would be created and writes nothing", async () => {
    const out: string[] = [];
    const result = await runImport({ csv: VALID, dryRun: true, sql, appUrl: APP, geocoder: tableGeocoder, out: (l) => out.push(l) });
    expect(result).toMatchObject({ ok: true, dry_run: true, profiles: 3, organisations: 2, locations: 2, geocoded: 2 });
    expect(out[0]).toMatch(/^Dry run: nothing was written/);
    expect(out.slice(1).map((l) => l.trim().slice(0, 6))).toEqual(["Row 2:", "Row 3:", "Row 4:"]);
    expect(out.join("\n")).not.toMatch(/\/claim\//);
    expect(await profilesByName()).toEqual([]);
  });

  it("imports unclaimed, unverified, unlisted profiles; claim links go to stdout only and work (028)", async () => {
    const before = snapshot(process.cwd());
    const out: string[] = [];
    const result = await runImport({ csv: VALID, dryRun: false, sql, appUrl: APP, geocoder: tableGeocoder, out: (l) => out.push(l) });
    expect(result).toMatchObject({ ok: true, profiles: 3, organisations: 2, locations: 2, geocoded: 2 });

    const rows = await profilesByName();
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r).toMatchObject({ verification_status: "unverified", listed: false, claimed: false, is_synthetic: false, user_id: null });
      expect(r.lat).not.toBeNull();
    }
    // Both centre rows share one organisation; the solo row has its own.
    const centre = rows.filter((r) => r.kind === "centre");
    expect(centre).toHaveLength(2);
    expect(centre[0].org_id).toBe(centre[1].org_id);

    // Links printed once each; only their hashes are stored; nothing on disk changed.
    const urls = result.imported.map((p) => p.claim_url);
    expect(urls).toHaveLength(3);
    for (const url of urls) {
      expect(url).toMatch(new RegExp(`^${APP}/claim/[A-Za-z0-9_-]{43}$`));
      expect(out.filter((l) => l.includes(url))).toHaveLength(1);
    }
    const tokens = urls.map((u) => u.split("/").pop() as string);
    const stored = await sql`select 1 from provider_claim_tokens where token_hash in ${sql(tokens)}`;
    expect(stored.length).toBe(0);
    expect(snapshot(process.cwd())).toEqual(before);

    // 028 E-2: the printed link works.
    const { previewClaim, claimProfile } = await import("@/lib/providers/claims");
    expect(await previewClaim(tokens[0])).toMatchObject({ display_name: "Dr. Synthetic Import One" });
    const user = await world.user("claimer", "guardian");
    const claimed = await claimProfile(tokens[0], user.id);
    expect(claimed.ok).toBe(true);
    expect(await previewClaim(tokens[0])).toBeNull();

    // A second import of the same file is refused as a whole.
    const again = await runImport({ csv: VALID, dryRun: false, sql, appUrl: APP, geocoder: tableGeocoder, out: () => {} });
    expect(again.ok).toBe(false);
    expect(again.errors.map((e) => e.row)).toEqual([2, 3, 4]);
    expect(await profilesByName()).toHaveLength(3);
  });
});
