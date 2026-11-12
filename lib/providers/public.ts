// Public directory data (ticket 028 FR-7, NFR-1, NFR-2). Only verified + listed profiles are ever returned;
// demo (is_synthetic) profiles are included unless SHOW_SYNTHETIC_LISTINGS=false. Never selects emails,
// user ids, the full registration number or the internal verification note.
import { revalidateTag, unstable_cache } from "next/cache";
import { supabaseAdmin } from "@/lib/db";
import { env } from "@/lib/env";
import { maskRegistrationNumber, type ProviderType } from "./constants";
import { listProfileLocations, LOCATION_COLUMNS, ORG_PUBLIC_COLUMNS, photoUrl, type Location, type OrgPublic } from "./index";

const SLUG = /^[a-z0-9][a-z0-9-]{1,78}[a-z0-9]$/;
const PUBLIC_COLUMNS =
  "id, slug, display_name, provider_type, qualifications, bio, languages, years_experience, photo_path, " +
  "registration_council, registration_state, registration_number, verified_at, time_zone, is_synthetic, offers_video, offers_in_clinic";

type PublicRow = {
  id: string;
  slug: string;
  display_name: string;
  provider_type: ProviderType;
  qualifications: string | null;
  bio: string | null;
  languages: string[];
  years_experience: number | null;
  photo_path: string | null;
  registration_council: string | null;
  registration_state: string | null;
  registration_number: string | null;
  verified_at: string | null;
  time_zone: string;
  is_synthetic: boolean;
  offers_video: boolean;
  offers_in_clinic: boolean;
};

export type PublicProvider = Omit<PublicRow, "photo_path" | "registration_number" | "registration_council" | "registration_state"> & {
  photo_url: string | null;
  // Council details only when the council is a statutory register (not OTHER), number masked to last 4.
  council: "NMC" | "STATE_MEDICAL_COUNCIL" | "RCI" | null;
  council_state: string | null;
  registration_masked: string | null;
};

export type PublicOrg = Pick<OrgPublic, "id" | "slug" | "kind" | "about" | "phone_public" | "website" | "listed"> & { name: string };
export type PublicLocation = Location & { org: PublicOrg };

function toPublicProvider(row: PublicRow): PublicProvider {
  const statutory = row.registration_council === "NMC" || row.registration_council === "STATE_MEDICAL_COUNCIL" || row.registration_council === "RCI";
  const { photo_path, registration_number, registration_council, registration_state, ...rest } = row;
  return {
    ...rest,
    photo_url: photoUrl(photo_path),
    council: statutory ? (registration_council as PublicProvider["council"]) : null,
    council_state: statutory && registration_council === "STATE_MEDICAL_COUNCIL" ? registration_state : null,
    registration_masked: statutory ? maskRegistrationNumber(registration_number) : null,
  };
}

function toPublicOrg(org: OrgPublic): PublicOrg {
  return {
    id: org.id,
    slug: org.slug,
    kind: org.kind,
    name: org.public_name ?? org.name,
    about: org.about,
    phone_public: org.phone_public,
    website: org.website,
    listed: org.listed,
  };
}

export async function loadPublicProfile(
  slug: string,
  showSynthetic: boolean,
): Promise<{ provider: PublicProvider; locations: PublicLocation[] } | null> {
  if (!SLUG.test(slug)) return null;
  let query = supabaseAdmin()
    .from("provider_profiles")
    .select(PUBLIC_COLUMNS)
    .eq("slug", slug)
    .eq("verification_status", "verified")
    .eq("listed", true);
  if (!showSynthetic) query = query.eq("is_synthetic", false);
  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(`Could not load public profile: ${error.message}`);
  if (!data) return null;
  const row = data as unknown as PublicRow;
  const locations = (await listProfileLocations(row.id)).map(({ org, ...loc }) => ({ ...loc, org: toPublicOrg(org) }));
  return { provider: toPublicProvider(row), locations };
}

export async function loadPublicCentre(
  slug: string,
  showSynthetic: boolean,
): Promise<{ org: PublicOrg; providers: PublicProvider[]; locations: Location[] } | null> {
  if (!SLUG.test(slug)) return null;
  const db = supabaseAdmin();
  const { data: orgRow, error } = await db.from("organizations").select(ORG_PUBLIC_COLUMNS).eq("slug", slug).eq("listed", true).maybeSingle();
  if (error) throw new Error(`Could not load organisation: ${error.message}`);
  if (!orgRow) return null;
  const org = orgRow as unknown as OrgPublic;

  const { data: links, error: linkError } = await db.from("provider_locations").select("provider_profile_id").eq("org_id", org.id);
  if (linkError) throw new Error(`Could not load providers: ${linkError.message}`);
  const ids = [...new Set(((links ?? []) as { provider_profile_id: string }[]).map((l) => l.provider_profile_id))];
  if (ids.length === 0) return null;

  let query = db
    .from("provider_profiles")
    .select(PUBLIC_COLUMNS)
    .in("id", ids)
    .eq("verification_status", "verified")
    .eq("listed", true)
    .order("display_name");
  if (!showSynthetic) query = query.eq("is_synthetic", false);
  const { data: rows, error: profileError } = await query;
  if (profileError) throw new Error(`Could not load providers: ${profileError.message}`);
  const providers = ((rows ?? []) as unknown as PublicRow[]).map(toPublicProvider);
  // A centre page exists only while it lists at least one verified provider (no unverified content).
  if (providers.length === 0) return null;

  const { data: locs, error: locError } = await db.from("practice_locations").select(LOCATION_COLUMNS).eq("org_id", org.id).order("name");
  if (locError) throw new Error(`Could not load locations: ${locError.message}`);
  const locations = (locs ?? []) as unknown as Location[];
  return { org: toPublicOrg(org), providers, locations };
}

// NFR-2: data for /p/<slug> and /c/<slug> is cached per slug and dropped on every profile/org change.
export const PUBLIC_PROVIDERS_TAG = "public-providers";

export function getPublicProfile(slug: string) {
  const show = env.SHOW_SYNTHETIC_LISTINGS;
  return unstable_cache(() => loadPublicProfile(slug, show), ["public-provider", slug, String(show)], {
    tags: [PUBLIC_PROVIDERS_TAG],
    revalidate: 3600,
  })();
}

export function getPublicCentre(slug: string) {
  const show = env.SHOW_SYNTHETIC_LISTINGS;
  return unstable_cache(() => loadPublicCentre(slug, show), ["public-centre", slug, String(show)], {
    tags: [PUBLIC_PROVIDERS_TAG],
    revalidate: 3600,
  })();
}

/** Call after any write that can change a public page. Expires immediately: a suspended or re-pending
 *  profile must not be served stale. */
export function invalidatePublicProviders(): void {
  revalidateTag(PUBLIC_PROVIDERS_TAG, { expire: 0 });
}
