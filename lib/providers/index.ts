// Server-side data access for provider profiles (ticket 028). Uses the service-role client: every caller
// must already have passed an authorisation gate (lib/authz.ts). Nothing here trusts client-sent roles,
// verification status or listing flags.
import { randomBytes } from "node:crypto";
import type { z } from "zod";
import { supabaseAdmin } from "@/lib/db";
import { slugify, type OrgRole } from "@/lib/orgs";
import { canPrescribe, PHOTO_BUCKET, profileSlug, type ProviderType, type VerificationStatus } from "./constants";
import type { LocationFields, OrgPublicSchema, ProfileUpdateSchema } from "./schemas";

export type Result<T> = { ok: true; data: T } | { ok: false; status: number; error: string };

export type ProviderProfile = {
  id: string;
  user_id: string | null;
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
  verification_status: VerificationStatus;
  verified_at: string | null;
  time_zone: string;
  listed: boolean;
  claimed: boolean;
  is_synthetic: boolean;
  offers_video: boolean;
  offers_in_clinic: boolean;
  created_at: string;
  updated_at: string;
};

// verification_note and verified_by are internal to platform admins and never selected here.
export const PROFILE_COLUMNS =
  "id, user_id, slug, display_name, provider_type, qualifications, bio, languages, years_experience, photo_path, " +
  "registration_council, registration_state, registration_number, verification_status, verified_at, time_zone, " +
  "listed, claimed, is_synthetic, offers_video, offers_in_clinic, created_at, updated_at";

export type Location = {
  id: string;
  org_id: string;
  name: string;
  address_line1: string;
  address_line2: string | null;
  locality: string;
  city: string;
  state: string;
  pincode: string;
  lat: number | null;
  lng: number | null;
  time_zone: string;
};

export const LOCATION_COLUMNS = "id, org_id, name, address_line1, address_line2, locality, city, state, pincode, lat, lng, time_zone";

export type OrgPublic = {
  id: string;
  name: string;
  slug: string;
  kind: "centre" | "solo";
  city: string | null;
  public_name: string | null;
  about: string | null;
  phone_public: string | null;
  website: string | null;
  listed: boolean;
};

export const ORG_PUBLIC_COLUMNS = "id, name, slug, kind, city, public_name, about, phone_public, website, listed";

export function withPrescriber<T extends Pick<ProviderProfile, "provider_type" | "verification_status" | "registration_council">>(
  profile: T,
): T & { can_prescribe: boolean } {
  return { ...profile, can_prescribe: canPrescribe(profile.provider_type, profile.verification_status, profile.registration_council) };
}

export function photoUrl(path: string | null): string | null {
  if (!path) return null;
  return supabaseAdmin().storage.from(PHOTO_BUCKET).getPublicUrl(path).data.publicUrl;
}

export async function getProfileById(id: string): Promise<ProviderProfile | null> {
  const { data, error } = await supabaseAdmin().from("provider_profiles").select(PROFILE_COLUMNS).eq("id", id).maybeSingle();
  if (error) throw new Error(`Could not load provider profile: ${error.message}`);
  return (data as unknown as ProviderProfile | null) ?? null;
}

export async function getProfileByUserId(userId: string): Promise<ProviderProfile | null> {
  const { data, error } = await supabaseAdmin()
    .from("provider_profiles")
    .select(PROFILE_COLUMNS)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`Could not load provider profile: ${error.message}`);
  return (data as unknown as ProviderProfile | null) ?? null;
}

export function newSlugSuffix(): string {
  return randomBytes(3).toString("hex");
}

// FR-2: solo org + owner membership + role `provider` + draft profile, in one transaction.
export async function registerProvider(
  userId: string,
  input: { full_name: string; provider_type: ProviderType },
): Promise<Result<{ profileId: string; created: boolean }>> {
  const { data, error } = await supabaseAdmin().rpc("register_provider", {
    p_user: userId,
    p_display_name: input.full_name,
    p_provider_type: input.provider_type,
    p_profile_slug: profileSlug(input.full_name, newSlugSuffix()),
    p_org_name: input.full_name,
    p_org_slug: slugify(input.full_name),
  });
  if (error) throw new Error(`Could not register provider: ${error.message}`);
  const outcome = data as { result: "created" | "exists" | "forbidden"; profile_id?: string };
  if (outcome.result === "forbidden") {
    return { ok: false, status: 403, error: "This account cannot register as a provider" };
  }
  return { ok: true, data: { profileId: outcome.profile_id as string, created: outcome.result === "created" } };
}

export async function updateProfile(id: string, patch: z.output<typeof ProfileUpdateSchema>): Promise<ProviderProfile> {
  const row = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  const { data, error } = await supabaseAdmin().from("provider_profiles").update(row).eq("id", id).select(PROFILE_COLUMNS).single();
  if (error) throw new Error(`Could not update provider profile: ${error.message}`);
  return data as unknown as ProviderProfile;
}

// FR-8: only a verified profile can be listed (also enforced by a check constraint and trigger).
export async function setListed(id: string, listed: boolean): Promise<Result<ProviderProfile>> {
  const profile = await getProfileById(id);
  if (!profile) return { ok: false, status: 404, error: "Profile not found" };
  if (listed && profile.verification_status !== "verified") {
    return { ok: false, status: 409, error: "Your profile must be verified before it can be listed" };
  }
  const { data, error } = await supabaseAdmin()
    .from("provider_profiles")
    .update({ listed })
    .eq("id", id)
    .select(PROFILE_COLUMNS)
    .single();
  if (error) throw new Error(`Could not update listing: ${error.message}`);
  return { ok: true, data: data as unknown as ProviderProfile };
}

export async function setPhotoPath(id: string, path: string | null): Promise<string | null> {
  const db = supabaseAdmin();
  const { data: before, error: loadError } = await db.from("provider_profiles").select("photo_path").eq("id", id).single();
  if (loadError) throw new Error(`Could not load provider profile: ${loadError.message}`);
  const { error } = await db.from("provider_profiles").update({ photo_path: path }).eq("id", id);
  if (error) throw new Error(`Could not save photo: ${error.message}`);
  return (before as { photo_path: string | null }).photo_path;
}

export type ProfileLocation = Location & { org: OrgPublic };

export async function listProfileLocations(profileId: string): Promise<ProfileLocation[]> {
  const db = supabaseAdmin();
  const { data, error } = await db
    .from("provider_locations")
    .select(`practice_locations(${LOCATION_COLUMNS}, organizations(${ORG_PUBLIC_COLUMNS}))`)
    .eq("provider_profile_id", profileId);
  if (error) throw new Error(`Could not load locations: ${error.message}`);
  type Row = { practice_locations: Location & { organizations: OrgPublic } };
  return ((data ?? []) as unknown as Row[])
    .map(({ practice_locations: { organizations, ...loc } }) => ({ ...loc, org: organizations }))
    .sort((a, b) => a.org.name.localeCompare(b.org.name) || a.name.localeCompare(b.name));
}

export type ManagedOrg = OrgPublic & { org_role: OrgRole; locations: Location[] };

/** Organisations the user is an active member of, with their locations (FR-3 "locations of the provider's org(s)"). */
export async function listUserOrgsWithLocations(userId: string): Promise<ManagedOrg[]> {
  const db = supabaseAdmin();
  const { data, error } = await db
    .from("org_members")
    .select(`org_role, organizations(${ORG_PUBLIC_COLUMNS}, practice_locations(${LOCATION_COLUMNS}))`)
    .eq("user_id", userId)
    .eq("status", "active");
  if (error) throw new Error(`Could not load organisations: ${error.message}`);
  type Row = { org_role: OrgRole; organizations: OrgPublic & { practice_locations: Location[] } };
  return ((data ?? []) as unknown as Row[])
    .map(({ org_role, organizations: { practice_locations, ...org } }) => ({
      ...org,
      org_role,
      locations: [...practice_locations].sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function getLocation(id: string): Promise<Location | null> {
  const { data, error } = await supabaseAdmin().from("practice_locations").select(LOCATION_COLUMNS).eq("id", id).maybeSingle();
  if (error) throw new Error(`Could not load location: ${error.message}`);
  return (data as unknown as Location | null) ?? null;
}

export async function createLocation(orgId: string, fields: z.output<typeof LocationFields>): Promise<Location> {
  const { data, error } = await supabaseAdmin()
    .from("practice_locations")
    .insert({ ...fields, org_id: orgId })
    .select(LOCATION_COLUMNS)
    .single();
  if (error) throw new Error(`Could not create location: ${error.message}`);
  return data as unknown as Location;
}

export async function linkLocation(profileId: string, location: Location): Promise<void> {
  const { error } = await supabaseAdmin()
    .from("provider_locations")
    .upsert(
      { provider_profile_id: profileId, location_id: location.id, org_id: location.org_id },
      { onConflict: "provider_profile_id,location_id", ignoreDuplicates: true },
    );
  if (error) throw new Error(`Could not link location: ${error.message}`);
}

export async function unlinkLocation(profileId: string, locationId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin()
    .from("provider_locations")
    .delete()
    .eq("provider_profile_id", profileId)
    .eq("location_id", locationId)
    .select("location_id");
  if (error) throw new Error(`Could not unlink location: ${error.message}`);
  return (data ?? []).length > 0;
}

export async function updateOrgPublic(orgId: string, patch: z.output<typeof OrgPublicSchema>): Promise<OrgPublic> {
  const row = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  const { data, error } = await supabaseAdmin().from("organizations").update(row).eq("id", orgId).select(ORG_PUBLIC_COLUMNS).single();
  if (error) throw new Error(`Could not update organisation: ${error.message}`);
  return data as unknown as OrgPublic;
}
