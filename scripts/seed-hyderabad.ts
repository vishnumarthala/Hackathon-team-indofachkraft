// Ticket 042: synthetic Hyderabad directory (demo + load tests). Fictional providers and centres across real Hyderabad
// localities, flagged `is_synthetic`, verified + listed (shown with a `Demo profile` badge; SHOW_SYNTHETIC_LISTINGS=false
// hides them), with services and weekly hours so they can be booked (demo bookings: lib/booking/hooks.ts, FR-2a).
//
// Usage: npm run -s seed:hyderabad -- [--count 60] [--seed 42] [--prefix demo-hyd] [--reset-synthetic]
//   --count            profiles to create (1-5000, default 60)
//   --seed             deterministic generator seed (default 42): same seed -> same names, types, coordinates
//   --prefix           slug prefix of every generated profile/organisation (default `demo-hyd`); lets several datasets
//                      (e.g. load tests) coexist and be reset separately
//   --reset-synthetic  delete instead of seed: is_synthetic profiles (only those under --prefix when it is given),
//                      their appointments, and the `(Demo)` organisations that only they used. Never touches anything else.
// Prints a JSON summary { action, providers, centres, locations, services, rules, ... }.
// Production guard: refuses to run unless NEXT_PUBLIC_SUPABASE_URL (and DATABASE_URL) point at a local stack, or
// ALLOW_SYNTHETIC_SEED=true. See docs/pilot-seeding.md.
import { loadEnvConfig } from "@next/env";
import type postgres from "postgres";
import geoTable from "../demo/fixtures/geocode/hyderabad.json";
import { PROVIDER_TYPES, type ProviderType } from "../lib/providers/constants";
import names from "./data/demo-names.json";
import localitiesFile from "./data/hyderabad-localities.json";

type Sql = postgres.Sql;
type Tx = postgres.TransactionSql;

// ---------- options + guard ----------

export type SeedOptions = { count: number; seed: number; prefix: string; reset: boolean; prefixGiven: boolean };

export const DEFAULT_COUNT = 60;
export const DEFAULT_SEED = 42;
export const DEFAULT_PREFIX = "demo-hyd";
export const MAX_COUNT = 5000;

export const USAGE = "usage: npm run -s seed:hyderabad -- [--count 60] [--seed 42] [--prefix demo-hyd] [--reset-synthetic]";

export function parseSeedArgs(argv: string[]): SeedOptions {
  const opts: SeedOptions = { count: DEFAULT_COUNT, seed: DEFAULT_SEED, prefix: DEFAULT_PREFIX, reset: false, prefixGiven: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${arg} needs a value. ${USAGE}`);
      return v;
    };
    if (arg === "--count") {
      const n = Number(value());
      if (!Number.isInteger(n) || n < 1 || n > MAX_COUNT) throw new Error(`--count must be a whole number from 1 to ${MAX_COUNT}`);
      opts.count = n;
    } else if (arg === "--seed") {
      const n = Number(value());
      if (!Number.isInteger(n) || n < 0 || n > 2 ** 31) throw new Error("--seed must be a whole number");
      opts.seed = n;
    } else if (arg === "--prefix") {
      const p = value();
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(p) || p.length > 24) throw new Error("--prefix: lowercase letters, digits and dashes, at most 24 characters");
      opts.prefix = p;
      opts.prefixGiven = true;
    } else if (arg === "--reset-synthetic") {
      opts.reset = true;
    } else {
      throw new Error(`Unknown option ${arg}. ${USAGE}`);
    }
  }
  return opts;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0", "host.docker.internal"]);

export function isLocalUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return LOCAL_HOSTS.has(host) || host.endsWith(".localhost");
  } catch {
    return false;
  }
}

/** FR-1 production guard: null when allowed, else the reason. Runs before any connection is opened. */
export function seedGuard(e: Record<string, string | undefined>): string | null {
  if (e.ALLOW_SYNTHETIC_SEED === "true") return null;
  if (!isLocalUrl(e.NEXT_PUBLIC_SUPABASE_URL)) {
    return "Refusing to write synthetic data: NEXT_PUBLIC_SUPABASE_URL is not a local Supabase. Set ALLOW_SYNTHETIC_SEED=true only for a staging demo project.";
  }
  if (!isLocalUrl(e.DATABASE_URL)) {
    return "Refusing to write synthetic data: DATABASE_URL is not a local database. Set ALLOW_SYNTHETIC_SEED=true only for a staging demo project.";
  }
  return null;
}

// ---------- deterministic generator (pure) ----------

/** mulberry32: small, fast, deterministic. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rand = () => number;
const pick = <T,>(r: Rand, list: readonly T[]): T => list[Math.floor(r() * list.length)];
const between = (r: Rand, min: number, max: number) => min + Math.floor(r() * (max - min + 1));
const chance = (r: Rand, p: number) => r() < p;

function weighted<T>(r: Rand, entries: readonly (readonly [T, number])[]): T {
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let x = r() * total;
  for (const [value, w] of entries) {
    x -= w;
    if (x < 0) return value;
  }
  return entries[entries.length - 1][0];
}

/** Realistic share of each provider type in a Hyderabad child-development directory (therapists dominate). */
export const TYPE_WEIGHTS: readonly (readonly [ProviderType, number])[] = [
  ["speech_language_pathologist", 18],
  ["occupational_therapist", 16],
  ["child_psychologist", 12],
  ["pediatrician", 12],
  ["special_educator", 11],
  ["aba_therapist", 10],
  ["physiotherapist", 9],
  ["developmental_pediatrician", 7],
  ["child_psychiatrist", 5],
];

const COUNCIL: Record<ProviderType, "NMC" | "RCI" | "OTHER"> = {
  developmental_pediatrician: "NMC",
  child_psychiatrist: "NMC",
  pediatrician: "NMC",
  child_psychologist: "RCI",
  special_educator: "RCI",
  speech_language_pathologist: "RCI",
  occupational_therapist: "OTHER",
  physiotherapist: "OTHER",
  aba_therapist: "OTHER",
};

const PROFILE: Record<ProviderType, { qualifications: string; focus: string; service: string; duration: number; intake: "child_dev" | "generic" }> = {
  developmental_pediatrician: { qualifications: "MD (Paediatrics), fellowship in developmental paediatrics (demo)", focus: "developmental milestones, autism and early intervention planning", service: "Developmental consultation", duration: 45, intake: "child_dev" },
  child_psychiatrist: { qualifications: "MD (Psychiatry), child and adolescent psychiatry (demo)", focus: "attention, behaviour and emotional wellbeing", service: "Psychiatry consultation", duration: 45, intake: "child_dev" },
  pediatrician: { qualifications: "MD (Paediatrics) (demo)", focus: "general child health, growth and vaccinations", service: "Paediatric consultation", duration: 20, intake: "generic" },
  child_psychologist: { qualifications: "M.Phil Clinical Psychology (demo)", focus: "developmental check-ins, parent guidance and behaviour support", service: "Psychology session", duration: 60, intake: "child_dev" },
  special_educator: { qualifications: "B.Ed Special Education (demo)", focus: "learning support and individual education plans", service: "Special education session", duration: 45, intake: "generic" },
  speech_language_pathologist: { qualifications: "MASLP (demo)", focus: "speech, language and social communication", service: "Speech therapy session", duration: 45, intake: "generic" },
  occupational_therapist: { qualifications: "MOT (Paediatrics) (demo)", focus: "sensory processing, fine motor skills and daily living", service: "Occupational therapy session", duration: 45, intake: "generic" },
  physiotherapist: { qualifications: "MPT (Paediatrics) (demo)", focus: "gross motor development and posture", service: "Physiotherapy session", duration: 45, intake: "generic" },
  aba_therapist: { qualifications: "MSc Psychology, ABA training (demo)", focus: "behaviour support and parent coaching", service: "ABA therapy session", duration: 60, intake: "generic" },
};

type TableLocality = { name: string; pincode?: string; lat: number; lng: number };
export type SeedLocality = { name: string; pincode: string; lat: number; lng: number; weight: number };

export const SEED_LOCALITIES: readonly SeedLocality[] = localitiesFile.localities.map((l) => {
  const hit = (geoTable as { localities: TableLocality[] }).localities.find((t) => t.name === l.table_name);
  if (!hit?.pincode) throw new Error(`scripts/data/hyderabad-localities.json: ${l.table_name} is not in demo/fixtures/geocode/hyderabad.json`);
  return { name: l.name, pincode: hit.pincode, lat: hit.lat, lng: hit.lng, weight: l.weight };
});

/** Synthetic locations stay within this distance of their locality centre (FR-1). */
export const JITTER_METERS = 800;
/** Rough Hyderabad metropolitan bounding box (tests: every generated coordinate falls inside). */
export const HYDERABAD_BBOX = { minLat: 17.2, maxLat: 17.65, minLng: 78.2, maxLng: 78.7 } as const;

const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

export function distanceMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** A point uniformly inside a disc of JITTER_METERS (minus a rounding margin) around the centre. */
function jitter(r: Rand, centre: { lat: number; lng: number }): { lat: number; lng: number } {
  const radius = (JITTER_METERS - 10) * Math.sqrt(r());
  const angle = 2 * Math.PI * r();
  const dLat = (radius * Math.cos(angle)) / 111_320;
  const dLng = (radius * Math.sin(angle)) / (111_320 * Math.cos((centre.lat * Math.PI) / 180));
  return { lat: round6(centre.lat + dLat), lng: round6(centre.lng + dLng) };
}

export type PlanLocation = { name: string; address_line1: string; locality: string; pincode: string; lat: number; lng: number };
export type PlanOrg = { slug: string; name: string; kind: "centre" | "solo"; phone_public: string; website: string; about: string; location: PlanLocation };
export type PlanService = {
  name: string;
  mode: "in_clinic" | "video";
  duration_min: number;
  fee_inr: number;
  payment_mode: "online" | "free";
  buffer_min: number;
  intake_kind: "child_dev" | "generic" | "none";
};
export type PlanRule = { weekday: number; start_time: string; end_time: string; mode: "in_clinic" | "both" };
export type PlanProvider = {
  slug: string;
  display_name: string;
  provider_type: ProviderType;
  qualifications: string;
  bio: string;
  languages: string[];
  years_experience: number;
  registration_council: "NMC" | "RCI" | "OTHER";
  registration_number: string;
  org: number;
  offers_video: boolean;
  services: PlanService[];
  rules: PlanRule[];
};
export type SeedPlan = { orgs: PlanOrg[]; providers: PlanProvider[] };

const pad = (n: number, width: number) => String(n).padStart(width, "0");
/** FR-2 test-range public phone numbers: +91 90000 0xxxx. */
export const demoPhone = (n: number) => `+91 90000 0${pad(n % 10000, 4)}`;

function fee(r: Rand, min = 500, max = 2500): number {
  return between(r, min / 100, max / 100) * 100;
}

function servicesFor(r: Rand, type: ProviderType, video: boolean): PlanService[] {
  const p = PROFILE[type];
  // 045 FR-2: "pay at clinic" is retired, every paid service is paid on DoctorNearMe. The draw stays so the rest of the
  // seeded plan (fees, buffers, ...) is unchanged.
  chance(r, 0.5);
  const inClinicPayment = "online";
  const list: PlanService[] = [
    { name: p.service, mode: "in_clinic", duration_min: p.duration, fee_inr: fee(r), payment_mode: inClinicPayment, buffer_min: pick(r, [0, 10, 15]), intake_kind: p.intake },
  ];
  if (video) {
    list.push({ name: "Video consultation", mode: "video", duration_min: 30, fee_inr: fee(r, 500, 2000), payment_mode: "online", buffer_min: pick(r, [0, 10]), intake_kind: p.intake });
    if (chance(r, 0.15)) {
      list.push({ name: "Free introductory call", mode: "video", duration_min: 15, fee_inr: 0, payment_mode: "free", buffer_min: 0, intake_kind: "none" });
    }
  }
  if ((type === "developmental_pediatrician" || type === "child_psychologist") && chance(r, 0.4)) {
    list.push({ name: "Developmental assessment", mode: "in_clinic", duration_min: pick(r, [60, 90]), fee_inr: fee(r, 1500, 2500), payment_mode: "online", buffer_min: 15, intake_kind: "child_dev" });
  }
  return list;
}

function rulesFor(r: Rand, video: boolean): PlanRule[] {
  const mode = video ? "both" : "in_clinic";
  const morning = between(r, 9, 10);
  const evening = between(r, 15, 16);
  const rules: PlanRule[] = [];
  for (let weekday = 0; weekday <= 4; weekday++) {
    rules.push({ weekday, start_time: `${pad(morning, 2)}:00`, end_time: `${pad(morning + 3, 2)}:00`, mode });
    rules.push({ weekday, start_time: `${pad(evening, 2)}:00`, end_time: `${pad(evening + 3, 2)}:00`, mode });
  }
  if (chance(r, 0.6)) rules.push({ weekday: 5, start_time: "10:00", end_time: "14:00", mode });
  return rules;
}

function slugPart(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function location(r: Rand, loc: SeedLocality, name: string, n: number): PlanLocation {
  const point = jitter(r, loc);
  return {
    name: name.slice(0, 120),
    address_line1: `(Demo) Plot ${between(r, 1, 199)}, ${pick(r, localitiesFile.streets)} ${(n % 9) + 1}`,
    locality: loc.name,
    pincode: loc.pincode,
    lat: point.lat,
    lng: point.lng,
  };
}

/** FR-1/FR-2: the whole dataset, computed from (count, seed, prefix) only. */
export function generateHyderabadDataset(opts: { count: number; seed: number; prefix: string }): SeedPlan {
  const r = rng(opts.seed);
  const { count, prefix } = opts;
  const localityWeights = SEED_LOCALITIES.map((l) => [l, l.weight] as const);
  // Every locality first (round-robin), then weighted: >= 12 localities whenever count allows.
  const localityOf = (i: number) => (i < SEED_LOCALITIES.length ? SEED_LOCALITIES[i] : weighted(r, localityWeights));

  // 8 centres at the default 60 profiles, scaled with the count; 2-5 providers each.
  const centreCount = count < 4 ? 0 : Math.max(1, Math.min(Math.floor(count / 5), Math.round((count * 8) / 60)));
  const orgs: PlanOrg[] = [];
  const centreSlots: number[] = [];
  for (let c = 0; c < centreCount; c++) {
    const loc = localityOf(c);
    const word = names.centre_words[c % names.centre_words.length];
    const round = Math.floor(c / names.centre_words.length);
    const name = `(Demo) ${word} Child Development Centre${round ? ` ${round + 1}` : ""}`;
    const slug = `${prefix}-centre-${pad(c + 1, 4)}`;
    orgs.push({
      slug,
      name,
      kind: "centre",
      phone_public: demoPhone(c + 1),
      website: `https://${slug}.example.com`,
      about: `Synthetic demo centre in ${loc.name}, Hyderabad, for trying DoctorNearMe. Not a real clinic.`,
      location: location(r, loc, `${name}, ${loc.name}`, c),
    });
    const size = between(r, 2, 5);
    for (let k = 0; k < size; k++) centreSlots.push(c);
  }
  // Never more centre places than profiles (small counts): every centre keeps at least 2 when possible.
  const centreAssign = centreSlots.slice(0, count);

  const providers: PlanProvider[] = [];
  for (let i = 0; i < count; i++) {
    // All 9 types first, then the realistic mix.
    const type = i < PROVIDER_TYPES.length ? TYPE_WEIGHTS[i][0] : weighted(r, TYPE_WEIGHTS);
    const given = pick(r, names.given_names);
    const initial = pick(r, names.initials);
    const display_name = `Dr. (Demo) ${given} ${initial}.`;
    const n = i + 1;
    const slug = `${prefix}-${pad(n, 4)}-${slugPart(`${given}-${initial}`)}`;
    const languages = ["en"];
    if (chance(r, 0.75)) languages.push("te");
    if (chance(r, 0.5)) languages.push("hi");
    if (chance(r, 0.15)) languages.push("ur");
    const video = chance(r, 0.55);
    let org: number;
    if (i < centreAssign.length) {
      org = centreAssign[i];
    } else {
      const loc = localityOf(centreCount + (i - centreAssign.length));
      const orgSlug = `${prefix}-practice-${pad(n, 4)}`;
      const name = `(Demo) ${given} ${initial}. Clinic`;
      orgs.push({
        slug: orgSlug,
        name,
        kind: "solo",
        phone_public: demoPhone(1000 + n),
        website: `https://${orgSlug}.example.com`,
        about: "Synthetic demo practice for trying DoctorNearMe. Not a real clinic.",
        location: location(r, loc, `${name}, ${loc.name}`, n),
      });
      org = orgs.length - 1;
    }
    const p = PROFILE[type];
    providers.push({
      slug,
      display_name,
      provider_type: type,
      qualifications: p.qualifications,
      bio: `Synthetic demo profile: not a real practitioner, no real consultation takes place. Shown to try DoctorNearMe; works with children on ${p.focus}.`,
      languages,
      years_experience: between(r, 2, 25),
      registration_council: COUNCIL[type],
      registration_number: `DEMO-${n}`,
      org,
      offers_video: video,
      services: servicesFor(r, type, video),
      rules: rulesFor(r, video),
    });
  }
  return { orgs, providers };
}

// ---------- database ----------

export type SeedSummary = {
  action: "seed" | "reset";
  providers: number;
  centres: number;
  locations: number;
  services: number;
  rules: number;
  [key: string]: unknown;
};

const CHUNK = 1000;
async function insertChunked<T extends Record<string, unknown>, R>(tx: Tx, table: string, rows: T[], returning: string): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const cols = Object.keys(chunk[0]).join(", ");
    const result = await tx.unsafe(
      `insert into public.${table} (${cols}) select ${cols} from json_populate_recordset(null::public.${table}, $1::json) ${returning ? `returning ${returning}` : ""}`,
      [tx.json(chunk as never) as never],
    );
    out.push(...(result as unknown as R[]));
  }
  return out;
}

/** Batch inserts in one transaction (NFR-1). All triggers (geography, consultation modes, location checks) still run. */
export async function writeDataset(sql: Sql, plan: SeedPlan, meta: { prefix: string; seed: number }): Promise<SeedSummary> {
  const existing = await sql<{ n: number }[]>`
    select count(*)::int as n from public.provider_profiles where slug like ${`${meta.prefix}-%`}`;
  if (existing[0].n > 0) {
    throw new Error(`${existing[0].n} profiles with prefix "${meta.prefix}" already exist. Run with --reset-synthetic --prefix ${meta.prefix} first, or pick another --prefix.`);
  }
  return (await sql.begin(async (tx) => {
    const orgRows = await insertChunked<Record<string, unknown>, { id: string; slug: string }>(
      tx,
      "organizations",
      plan.orgs.map((o) => ({ name: o.name, slug: o.slug, kind: o.kind, city: "Hyderabad", public_name: o.name, about: o.about, phone_public: o.phone_public, website: o.website, listed: true })),
      "id, slug",
    );
    const orgId = new Map(orgRows.map((o) => [o.slug, o.id]));
    const locRows = await insertChunked<Record<string, unknown>, { id: string; org_id: string }>(
      tx,
      "practice_locations",
      plan.orgs.map((o) => ({ org_id: orgId.get(o.slug), ...o.location, city: "Hyderabad", state: "Telangana" })),
      "id, org_id",
    );
    const locOf = new Map(locRows.map((l) => [l.org_id, l.id]));

    const now = new Date().toISOString();
    const profileRows = await insertChunked<Record<string, unknown>, { id: string; slug: string }>(
      tx,
      "provider_profiles",
      plan.providers.map((p) => ({
        slug: p.slug,
        display_name: p.display_name,
        provider_type: p.provider_type,
        qualifications: p.qualifications,
        bio: p.bio,
        languages: p.languages,
        years_experience: p.years_experience,
        registration_council: p.registration_council,
        registration_number: p.registration_number,
        verification_status: "verified",
        verified_at: now,
        verification_note: "Synthetic demo profile (npm run seed:hyderabad). No real registration was checked.",
        listed: true,
        claimed: false,
        is_synthetic: true,
        offers_in_clinic: true,
        offers_video: p.offers_video,
      })),
      "id, slug",
    );
    const profileId = new Map(profileRows.map((p) => [p.slug, p.id]));

    const links: Record<string, unknown>[] = [];
    const services: Record<string, unknown>[] = [];
    const rules: Record<string, unknown>[] = [];
    for (const p of plan.providers) {
      const id = profileId.get(p.slug);
      const org = orgId.get(plan.orgs[p.org].slug);
      const loc = locOf.get(org as string);
      links.push({ provider_profile_id: id, location_id: loc, org_id: org });
      for (const s of p.services) {
        services.push({ provider_profile_id: id, org_id: org, location_id: s.mode === "in_clinic" ? loc : null, ...s, active: true });
      }
      for (const rule of p.rules) {
        rules.push({ provider_profile_id: id, org_id: org, location_id: loc, ...rule, valid_from: now.slice(0, 10) });
      }
    }
    await insertChunked(tx, "provider_locations", links, "");
    await insertChunked(tx, "services", services, "");
    await insertChunked(tx, "availability_rules", rules, "");

    const summary: SeedSummary = {
      action: "seed",
      prefix: meta.prefix,
      seed: meta.seed,
      providers: plan.providers.length,
      centres: plan.orgs.filter((o) => o.kind === "centre").length,
      solo_practices: plan.orgs.filter((o) => o.kind === "solo").length,
      locations: plan.orgs.length,
      services: services.length,
      rules: rules.length,
      localities: new Set(plan.orgs.map((o) => o.location.locality)).size,
      types: new Set(plan.providers.map((p) => p.provider_type)).size,
    };
    await tx`
      insert into public.audit_events (actor, action, entity, entity_id, details)
      values ('system', 'seed.synthetic_providers', 'seed', ${meta.prefix}, ${tx.json(summary as never)})`;
    return summary;
  })) as SeedSummary;
}

/**
 * FR-3: deletes is_synthetic profiles (under `prefix` when given), their appointments (and those appointments' unsent
 * notifications and demo payments), and the `(Demo)` organisations that nothing else uses. Non-synthetic rows are never
 * selected: organisations with members, cases, documents, threads, grants or a non-synthetic provider stay.
 */
export async function resetSynthetic(sql: Sql, opts: { prefix?: string } = {}): Promise<SeedSummary> {
  return (await sql.begin(async (tx) => {
    const like = opts.prefix ? `${opts.prefix}-%` : "%";
    const profiles = (await tx<{ id: string }[]>`
      select id from public.provider_profiles where is_synthetic and slug like ${like}`).map((p) => p.id);
    const summary: SeedSummary = { action: "reset", prefix: opts.prefix ?? null, providers: 0, centres: 0, solo_practices: 0, locations: 0, services: 0, rules: 0, appointments: 0 };
    if (profiles.length === 0) return summary;

    // (Demo) organisations whose providers are all being removed.
    const candidateOrgs = (await tx<{ id: string; kind: string }[]>`
      select o.id, o.kind from public.organizations o
      where o.name like '(Demo) %'
        and exists (select 1 from public.provider_locations pl where pl.org_id = o.id and pl.provider_profile_id in ${tx(profiles)})
        and not exists (select 1 from public.provider_locations pl where pl.org_id = o.id and pl.provider_profile_id not in ${tx(profiles)})
        and not exists (select 1 from public.services s where s.org_id = o.id and s.provider_profile_id not in ${tx(profiles)})
        and not exists (select 1 from public.appointments a where a.org_id = o.id and a.provider_profile_id not in ${tx(profiles)})`);
    // Any other table that references an organisation (members, cases, documents, threads, grants, later tickets'
    // tables) keeps the organisation.
    const refs = await tx<{ tbl: string; col: string }[]>`
      select c.conrelid::regclass::text as tbl, a.attname as col
      from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
      where c.contype = 'f' and c.confrelid = 'public.organizations'::regclass and array_length(c.conkey, 1) = 1
        and c.conrelid::regclass::text not in ('practice_locations', 'services', 'availability_rules', 'availability_overrides', 'appointments')`;
    const orgs: { id: string; kind: string }[] = [];
    for (const org of candidateOrgs) {
      let used = false;
      for (const ref of refs) {
        const [row] = (await tx.unsafe(`select exists (select 1 from ${ref.tbl} where "${ref.col.replace(/"/g, '""')}" = $1) as used`, [org.id])) as unknown as { used: boolean }[];
        if (row.used) {
          used = true;
          break;
        }
      }
      if (!used) orgs.push(org);
    }

    const appts = (await tx<{ id: string }[]>`select id from public.appointments where provider_profile_id in ${tx(profiles)}`).map((a) => a.id);
    for (const id of appts) {
      await tx`select public.outbox_cancel(${`appt:${id}:`}), public.outbox_cancel(${`meet:${id}:`})`;
    }
    if (appts.length) {
      // Demo bookings are never paid (042); older test-mode payments of synthetic providers go with their appointment.
      await tx`delete from public.payments where appointment_id in ${tx(appts)}`;
      await tx`delete from public.appointments where id in ${tx(appts)}`;
    }
    const [counts] = await tx<{ services: number; rules: number }[]>`
      select (select count(*)::int from public.services where provider_profile_id in ${tx(profiles)}) as services,
             (select count(*)::int from public.availability_rules where provider_profile_id in ${tx(profiles)}) as rules`;
    await tx`delete from public.provider_profiles where id in ${tx(profiles)} and is_synthetic`;
    let locations = 0;
    if (orgs.length) {
      const ids = orgs.map((o) => o.id);
      [{ n: locations }] = await tx<{ n: number }[]>`select count(*)::int as n from public.practice_locations where org_id in ${tx(ids)}`;
      await tx`delete from public.organizations where id in ${tx(ids)}`;
    }
    Object.assign(summary, {
      providers: profiles.length,
      centres: orgs.filter((o) => o.kind === "centre").length,
      solo_practices: orgs.filter((o) => o.kind === "solo").length,
      locations,
      services: counts.services,
      rules: counts.rules,
      appointments: appts.length,
    });
    await tx`
      insert into public.audit_events (actor, action, entity, entity_id, details)
      values ('system', 'seed.synthetic_reset', 'seed', ${opts.prefix ?? "all"}, ${tx.json(summary as never)})`;
    return summary;
  })) as SeedSummary;
}

async function main() {
  loadEnvConfig(process.cwd(), false, { info: () => {}, error: console.error });
  const opts = parseSeedArgs(process.argv.slice(2));
  const blocked = seedGuard(process.env);
  if (blocked) {
    console.error(blocked);
    process.exit(2);
  }
  const { default: postgresClient } = await import("postgres");
  const { env } = await import("../lib/env");
  const sql = postgresClient(env.DATABASE_URL, { max: 1, prepare: false, onnotice: () => {} });
  const started = Date.now();
  try {
    const summary = opts.reset
      ? await resetSynthetic(sql, { prefix: opts.prefixGiven ? opts.prefix : undefined })
      : await writeDataset(sql, generateHyderabadDataset(opts), { prefix: opts.prefix, seed: opts.seed });
    console.log(JSON.stringify({ ...summary, ms: Date.now() - started }));
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (process.argv[1] && /seed-hyderabad\.ts$/.test(process.argv[1])) {
  main().catch((err) => {
    console.error(`seed:hyderabad failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
