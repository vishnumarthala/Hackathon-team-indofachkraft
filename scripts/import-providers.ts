// Ticket 042 FR-4: import real, recruited pilot providers from a CSV as unclaimed, unverified, unlisted profiles and
// print one claim link per profile (028) to stdout. Only import providers who agreed to be contacted and listed
// (docs/pilot-seeding.md).
//
// Usage: npm run -s import:providers -- --file <csv> [--dry-run] [--admin <platform admin email>]
// Columns (header row, any order): display_name, provider_type, org_name, org_kind, address_line1, locality, pincode,
// phone_public, languages, website. `languages`: codes separated by `;`, `|` or spaces (en, hi, te, ur, ta, kn, mr).
// Every row is validated first (028's admin seeding rules); any error -> a report with row numbers and nothing is
// imported. Addresses are geocoded like 029's admin seeding. Everything is written in one transaction (all or nothing).
// Claim links are printed only: their tokens are never written to disk or stored (only the SHA-256 hash is).
import { loadEnvConfig } from "@next/env";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type postgres from "postgres";
import type { Geocoder } from "../lib/geo/geocode";
import { CLAIM_TTL_DAYS, PROFILE_LANGUAGES, PROVIDER_TYPES, profileSlug } from "../lib/providers/constants";
import { SeedSchema } from "../lib/providers/schemas";
import { newToken } from "../lib/tokens";

type Sql = postgres.Sql;

export const IMPORT_COLUMNS = [
  "display_name",
  "provider_type",
  "org_name",
  "org_kind",
  "address_line1",
  "locality",
  "pincode",
  "phone_public",
  "languages",
  "website",
] as const;
type Column = (typeof IMPORT_COLUMNS)[number];

export const USAGE = "usage: npm run -s import:providers -- --file <csv> [--dry-run] [--admin <platform admin email>]";

// ---------- CSV (RFC 4180: quoted fields, "" escapes, CRLF/LF, optional BOM) ----------

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"' && field === "") {
      quoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (quoted) throw new Error("The CSV has an unclosed quote");
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  // Blank lines carry no data.
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

// ---------- validation ----------

export type RowError = { row: number; column?: string; message: string };

export type ImportRow = {
  /** Line number in the file (the header is row 1). */
  row: number;
  display_name: string;
  provider_type: (typeof PROVIDER_TYPES)[number];
  org_name: string;
  org_kind: "centre" | "solo";
  address_line1: string;
  locality: string;
  pincode: string;
  phone_public: string | null;
  languages: string[];
  website: string | null;
};

const PHONE = /^\+?[0-9][0-9 -]{5,19}$/;
const WEBSITE = /^https?:\/\/\S+$/;

/** FR-4: every row checked with 028's seeding rules plus the database's format checks. */
export function validateCsv(text: string): { rows: ImportRow[]; errors: RowError[] } {
  const errors: RowError[] = [];
  let table: string[][];
  try {
    table = parseCsv(text);
  } catch (err) {
    return { rows: [], errors: [{ row: 0, message: (err as Error).message }] };
  }
  if (table.length === 0) return { rows: [], errors: [{ row: 1, message: "The file is empty" }] };
  const header = table[0].map((h) => h.trim().toLowerCase());
  const missing = IMPORT_COLUMNS.filter((c) => !header.includes(c));
  const unknown = header.filter((h) => !(IMPORT_COLUMNS as readonly string[]).includes(h));
  if (missing.length) errors.push({ row: 1, message: `Missing column(s): ${missing.join(", ")}` });
  if (unknown.length) errors.push({ row: 1, message: `Unknown column(s): ${unknown.join(", ")}` });
  if (errors.length) return { rows: [], errors };
  if (table.length === 1) return { rows: [], errors: [{ row: 1, message: "The file has no provider rows" }] };

  const rows: ImportRow[] = [];
  const seen = new Map<string, number>();
  table.slice(1).forEach((cells, index) => {
    const row = index + 2;
    if (cells.length !== header.length) {
      errors.push({ row, message: `Expected ${header.length} values, found ${cells.length}` });
      return;
    }
    const get = (c: Column) => cells[header.indexOf(c)].trim();
    const rowErrors: RowError[] = [];

    const languages = get("languages")
      .toLowerCase()
      .split(/[;|,\s]+/)
      .filter(Boolean);
    const badLanguages = languages.filter((l) => !(PROFILE_LANGUAGES as readonly string[]).includes(l));
    if (badLanguages.length) {
      rowErrors.push({ row, column: "languages", message: `Unknown language code(s): ${badLanguages.join(", ")} (use ${PROFILE_LANGUAGES.join(", ")})` });
    }
    const providerType = get("provider_type").toLowerCase().replace(/[\s-]+/g, "_");
    if (!(PROVIDER_TYPES as readonly string[]).includes(providerType)) {
      rowErrors.push({ row, column: "provider_type", message: `Unknown provider type "${get("provider_type")}" (use one of ${PROVIDER_TYPES.join(", ")})` });
    }
    const orgKind = get("org_kind").toLowerCase();
    if (orgKind !== "centre" && orgKind !== "solo") rowErrors.push({ row, column: "org_kind", message: "Use centre or solo" });
    const phone = get("phone_public");
    if (phone && !PHONE.test(phone)) rowErrors.push({ row, column: "phone_public", message: "Enter a valid phone number" });
    const website = get("website");
    if (website && (!WEBSITE.test(website) || website.length > 200)) {
      rowErrors.push({ row, column: "website", message: "Enter a full web address (https://...)" });
    }
    if (!get("org_name")) rowErrors.push({ row, column: "org_name", message: "Organisation name is required" });

    const parsed = SeedSchema.safeParse({
      org_name: get("org_name"),
      org_kind: orgKind === "solo" ? "solo" : "centre",
      phone_public: phone || null,
      website: website || null,
      location: {
        name: get("org_name") || get("display_name"),
        address_line1: get("address_line1"),
        locality: get("locality"),
        pincode: get("pincode"),
      },
      display_name: get("display_name"),
      provider_type: (PROVIDER_TYPES as readonly string[]).includes(providerType) ? providerType : PROVIDER_TYPES[0],
      languages: badLanguages.length ? [] : [...new Set(languages)],
      verified: false,
      is_synthetic: false,
    });
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const path = issue.path.map(String);
        const column = path[0] === "location" ? (path[1] === "name" ? "org_name" : path[1]) : path[0];
        if (column === "org_name" && rowErrors.some((e) => e.column === "org_name")) continue;
        rowErrors.push({ row, column, message: issue.message });
      }
    }
    const dupKey = `${get("display_name").toLowerCase()}|${get("pincode")}`;
    if (seen.has(dupKey)) rowErrors.push({ row, column: "display_name", message: `Same provider and PIN code as row ${seen.get(dupKey)}` });
    else seen.set(dupKey, row);

    if (rowErrors.length || !parsed.success) {
      errors.push(...rowErrors);
      return;
    }
    const v = parsed.data;
    rows.push({
      row,
      display_name: v.display_name,
      provider_type: v.provider_type,
      org_name: v.org_name as string,
      org_kind: v.org_kind,
      address_line1: v.location!.address_line1,
      locality: v.location!.locality,
      pincode: v.location!.pincode,
      phone_public: v.phone_public ?? null,
      languages: v.languages,
      website: v.website ?? null,
    });
  });
  return { rows, errors };
}

// ---------- import ----------

export type ImportedProfile = { row: number; display_name: string; profile_id: string; slug: string; claim_url: string; expires_at: string; geocoded: boolean };
export type ImportResult = {
  ok: boolean;
  dry_run: boolean;
  errors: RowError[];
  profiles: number;
  organisations: number;
  locations: number;
  geocoded: number;
  imported: ImportedProfile[];
};

export type ImportOptions = {
  csv: string;
  dryRun: boolean;
  sql: Sql;
  appUrl: string;
  /** Platform admin recorded as creator (optional). */
  adminId?: string | null;
  geocoder?: Geocoder;
  /** Where the report and the claim links go (stdout in the CLI). Never a file. */
  out: (line: string) => void;
  now?: Date;
};

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");
const suffix = () => randomBytes(3).toString("hex");
const orgSlug = (name: string) =>
  `${
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
      .replace(/-+$/g, "") || "org"
  }-${suffix()}`;

export function formatErrors(errors: RowError[]): string[] {
  return errors.map((e) => `Row ${e.row}${e.column ? `, ${e.column}` : ""}: ${e.message}`);
}

export async function runImport(opts: ImportOptions): Promise<ImportResult> {
  const { rows, errors } = validateCsv(opts.csv);
  const result: ImportResult = { ok: false, dry_run: opts.dryRun, errors, profiles: 0, organisations: 0, locations: 0, geocoded: 0, imported: [] };

  // Already in the directory (a real, non-demo profile with the same name at the same PIN code)?
  if (rows.length) {
    const existing = await opts.sql<{ name: string; pincode: string; slug: string }[]>`
      select lower(p.display_name) as name, l.pincode, p.slug
      from public.provider_profiles p
      join public.provider_locations pl on pl.provider_profile_id = p.id
      join public.practice_locations l on l.id = pl.location_id
      where not p.is_synthetic and lower(p.display_name) in ${opts.sql(rows.map((r) => r.display_name.toLowerCase()))}`;
    for (const r of rows) {
      const hit = existing.find((e) => e.name === r.display_name.toLowerCase() && e.pincode === r.pincode);
      if (hit) errors.push({ row: r.row, column: "display_name", message: `A provider with this name already exists at this PIN code (profile ${hit.slug})` });
    }
  }
  if (errors.length) {
    errors.sort((a, b) => a.row - b.row);
    return result;
  }

  // Organisations: rows of the same centre (same name) share one organisation; same address -> same location.
  type OrgPlan = { key: string; name: string; kind: "centre" | "solo"; slug: string; phone: string | null; website: string | null };
  type LocPlan = { key: string; org: OrgPlan; row: ImportRow; lat: number | null; lng: number | null; geocoded: boolean };
  const orgs = new Map<string, OrgPlan>();
  const locs = new Map<string, LocPlan>();
  const plan: { row: ImportRow; org: OrgPlan; loc: LocPlan }[] = [];
  const { geocodeLocationFields } = await import("../lib/geo/geocode");
  for (const r of rows) {
    const orgKey = r.org_kind === "centre" ? `centre|${r.org_name.toLowerCase()}` : `solo|${r.row}`;
    let org = orgs.get(orgKey);
    if (!org) {
      org = { key: orgKey, name: r.org_name, kind: r.org_kind, slug: orgSlug(r.org_name), phone: r.phone_public, website: r.website };
      orgs.set(orgKey, org);
    }
    const locKey = `${orgKey}|${r.address_line1.toLowerCase()}|${r.pincode}`;
    let loc = locs.get(locKey);
    if (!loc) {
      const geo = await geocodeLocationFields(
        { address_line1: r.address_line1, locality: r.locality, city: "Hyderabad", state: "Telangana", pincode: r.pincode },
        { trustCoordinates: false, geocoder: opts.geocoder },
      );
      loc = { key: locKey, org, row: r, lat: geo.fields.lat, lng: geo.fields.lng, geocoded: geo.geocoded };
      locs.set(locKey, loc);
    }
    plan.push({ row: r, org, loc });
  }
  result.profiles = plan.length;
  result.organisations = orgs.size;
  result.locations = locs.size;
  result.geocoded = [...locs.values()].filter((l) => l.geocoded).length;

  if (opts.dryRun) {
    opts.out(`Dry run: nothing was written. ${plan.length} profile(s) would be created (unclaimed, unverified, unlisted):`);
    for (const p of plan) {
      opts.out(
        `  Row ${p.row.row}: ${p.row.display_name} (${p.row.provider_type}) at ${p.org.name} [${p.org.kind}], ${p.row.locality} ${p.row.pincode}` +
          (p.loc.geocoded ? "" : " - not found on the map (check the PIN code; saved without coordinates)"),
      );
    }
    result.ok = true;
    return result;
  }

  const now = opts.now ?? new Date();
  const expiresAt = new Date(now.getTime() + CLAIM_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const imported = await opts.sql.begin(async (tx) => {
    const orgIds = new Map<string, string>();
    const locIds = new Map<string, string>();
    const out: ImportedProfile[] = [];
    for (const p of plan) {
      const orgId = orgIds.get(p.org.key) ?? null;
      const locId = locIds.get(p.loc.key) ?? null;
      const slug = profileSlug(p.row.display_name, suffix());
      const payload = {
        org_id: orgId,
        location_id: locId,
        org_name: p.org.name,
        org_slug: p.org.slug,
        org_kind: p.org.kind,
        phone_public: p.org.phone,
        website: p.org.website,
        location_name: p.org.name,
        address_line1: p.loc.row.address_line1,
        locality: p.loc.row.locality,
        pincode: p.loc.row.pincode,
        lat: p.loc.lat,
        lng: p.loc.lng,
        slug,
        display_name: p.row.display_name,
        provider_type: p.row.provider_type,
        languages: p.row.languages,
        verified: false,
        is_synthetic: false,
      };
      const [{ outcome }] = await tx<{ outcome: { result: string; profile_id: string; org_id: string; location_id: string } }[]>`
        select public.seed_provider_profile(${opts.adminId ?? null}::uuid, ${tx.json(payload as never)}) as outcome`;
      if (outcome.result !== "created") throw new Error(`Row ${p.row.row}: could not create the profile (${outcome.result})`);
      orgIds.set(p.org.key, outcome.org_id);
      locIds.set(p.loc.key, outcome.location_id);

      const token = newToken();
      const [{ created }] = await tx<{ created: string }[]>`
        select public.create_provider_claim_token(${outcome.profile_id}::uuid, ${sha256(token)}, ${expiresAt}::timestamptz, ${opts.adminId ?? null}::uuid) as created`;
      if (created !== "created") throw new Error(`Row ${p.row.row}: could not create a claim link (${created})`);
      await tx`
        insert into public.audit_events (actor, actor_user_id, action, entity, entity_id, org_id, details)
        values (${opts.adminId ? null : "system"}, ${opts.adminId ?? null}, 'provider.imported', 'provider_profile', ${outcome.profile_id},
                ${outcome.org_id}, ${tx.json({ via: "import:providers", row: p.row.row, geocoded: p.loc.geocoded })})`;
      out.push({
        row: p.row.row,
        display_name: p.row.display_name,
        profile_id: outcome.profile_id,
        slug,
        claim_url: `${opts.appUrl.replace(/\/$/, "")}/claim/${token}`,
        expires_at: expiresAt,
        geocoded: p.loc.geocoded,
      });
    }
    return out;
  });

  result.imported = imported;
  result.ok = true;
  opts.out(`Imported ${imported.length} profile(s): unclaimed, unverified, not listed. Claim links (valid ${CLAIM_TTL_DAYS} days, shown once, not saved anywhere):`);
  for (const p of imported) {
    opts.out(`  Row ${p.row}: ${p.display_name} -> ${p.claim_url}${p.geocoded ? "" : "  (not on the map yet: check the PIN code)"}`);
  }
  return result;
}

function parseArgs(argv: string[]): { file: string; dryRun: boolean; admin: string | null } {
  let file: string | null = null;
  let dryRun = false;
  let admin: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--file") file = argv[++i] ?? null;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--admin") admin = argv[++i] ?? null;
    else throw new Error(`Unknown option ${arg}. ${USAGE}`);
  }
  if (!file) throw new Error(USAGE);
  return { file, dryRun, admin };
}

async function main() {
  loadEnvConfig(process.cwd(), false, { info: () => {}, error: console.error });
  const args = parseArgs(process.argv.slice(2));
  const csv = readFileSync(args.file, "utf8");
  const { default: postgresClient } = await import("postgres");
  const { env } = await import("../lib/env");
  const sql = postgresClient(env.DATABASE_URL, { max: 1, prepare: false, onnotice: () => {} });
  try {
    let adminId: string | null = null;
    if (args.admin) {
      const [admin] = await sql<{ id: string }[]>`
        select u.id from auth.users u join public.user_profiles p on p.id = u.id
        where lower(u.email) = lower(${args.admin}) and p.role = 'platform_admin'`;
      if (!admin) throw new Error(`${args.admin} is not a platform admin account`);
      adminId = admin.id;
    }
    const result = await runImport({ csv, dryRun: args.dryRun, sql, appUrl: env.NEXT_PUBLIC_APP_URL, adminId, out: (line) => console.log(line) });
    if (!result.ok) {
      console.error(`Nothing was imported. Fix these rows and run again:`);
      for (const line of formatErrors(result.errors)) console.error(`  ${line}`);
      process.exitCode = 1;
      return;
    }
    const { profiles, organisations, locations, geocoded, dry_run } = result;
    console.log(JSON.stringify({ action: "import", dry_run, profiles, organisations, locations, geocoded }));
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (process.argv[1] && /import-providers\.ts$/.test(process.argv[1])) {
  main().catch((err) => {
    console.error(`import:providers failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
