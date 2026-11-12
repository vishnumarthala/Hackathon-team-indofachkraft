// Admin seeding and claim links (ticket 028 FR-5/FR-6). Tokens are 43-char base64url strings; only their
// SHA-256 hash is stored. Creating a new link revokes the previous ones; a link works once.
import type { z } from "zod";
import { supabaseAdmin } from "@/lib/db";
import { notifyLater, PROVIDER_TOPICS } from "@/lib/notify/topics";
import { hashToken, slugify } from "@/lib/orgs";
import { newToken } from "@/lib/tokens";
import { CLAIM_TTL_DAYS, profileSlug } from "./constants";
import { newSlugSuffix, type Result } from "./index";
import type { SeedSchema } from "./schemas";

export function claimUrl(appUrl: string, token: string): string {
  return `${appUrl.replace(/\/$/, "")}/claim/${token}`;
}

export async function seedProvider(
  adminId: string,
  input: z.output<typeof SeedSchema>,
): Promise<Result<{ profileId: string; orgId: string; locationId: string; slug: string }>> {
  const slug = profileSlug(input.display_name, newSlugSuffix());
  const payload = {
    org_id: input.org_id ?? null,
    location_id: input.location_id ?? null,
    org_name: input.org_name ?? null,
    org_slug: input.org_name ? slugify(input.org_name) : null,
    org_kind: input.org_kind,
    phone_public: input.phone_public ?? null,
    website: input.website ?? null,
    location_name: input.location?.name ?? null,
    address_line1: input.location?.address_line1 ?? null,
    address_line2: input.location?.address_line2 ?? null,
    locality: input.location?.locality ?? null,
    city: input.location?.city ?? null,
    state: input.location?.state ?? null,
    pincode: input.location?.pincode ?? null,
    lat: input.location?.lat ?? null,
    lng: input.location?.lng ?? null,
    slug,
    display_name: input.display_name,
    provider_type: input.provider_type,
    qualifications: input.qualifications ?? null,
    bio: input.bio ?? null,
    languages: input.languages,
    years_experience: input.years_experience ?? null,
    registration_council: input.registration_council ?? null,
    registration_state: input.registration_state ?? null,
    registration_number: input.registration_number ?? null,
    verified: input.verified,
    verification_note: input.verification_note ?? null,
    is_synthetic: input.is_synthetic,
  };
  const { data, error } = await supabaseAdmin().rpc("seed_provider_profile", { p_admin: adminId, p: payload });
  if (error) throw new Error(`Could not seed provider: ${error.message}`);
  const outcome = data as { result: string; profile_id?: string; org_id?: string; location_id?: string };
  if (outcome.result === "org_not_found") return { ok: false, status: 404, error: "Organisation not found" };
  if (outcome.result === "location_not_found") return { ok: false, status: 404, error: "Location not found" };
  // 029: consultation modes are plain profile flags (no verification impact), set after the seed transaction.
  if (input.offers_in_clinic !== undefined || input.offers_video !== undefined) {
    const modes = Object.fromEntries(
      Object.entries({ offers_in_clinic: input.offers_in_clinic, offers_video: input.offers_video }).filter(([, v]) => v !== undefined),
    );
    const { error: modeError } = await supabaseAdmin().from("provider_profiles").update(modes).eq("id", outcome.profile_id as string);
    if (modeError) throw new Error(`Could not set consultation modes: ${modeError.message}`);
  }
  return {
    ok: true,
    data: {
      profileId: outcome.profile_id as string,
      orgId: outcome.org_id as string,
      locationId: outcome.location_id as string,
      slug,
    },
  };
}

export async function createClaimLink(
  profileId: string,
  adminId: string,
  now: Date = new Date(),
): Promise<Result<{ token: string; expiresAt: string }>> {
  const token = newToken();
  const expiresAt = new Date(now.getTime() + CLAIM_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabaseAdmin().rpc("create_provider_claim_token", {
    p_profile: profileId,
    p_hash: hashToken(token),
    p_expires: expiresAt,
    p_creator: adminId,
  });
  if (error) throw new Error(`Could not create claim link: ${error.message}`);
  if (data === "not_found") return { ok: false, status: 404, error: "Profile not found" };
  if (data === "claimed") return { ok: false, status: 409, error: "This profile has already been claimed" };
  return { ok: true, data: { token, expiresAt } };
}

export type ClaimPreview = { display_name: string; provider_type: string };

/** What the claim page may show for a still-valid link; null for invalid, expired, used or revoked links. */
export async function previewClaim(token: string, now: Date = new Date()): Promise<ClaimPreview | null> {
  const { data, error } = await supabaseAdmin()
    .from("provider_claim_tokens")
    .select("expires_at, used_at, revoked_at, provider_profiles(display_name, provider_type, user_id, claimed)")
    .eq("token_hash", hashToken(token))
    .maybeSingle();
  if (error) throw new Error(`Could not load claim link: ${error.message}`);
  type Row = {
    expires_at: string;
    used_at: string | null;
    revoked_at: string | null;
    provider_profiles: ClaimPreview & { user_id: string | null; claimed: boolean };
  };
  const row = data as unknown as Row | null;
  if (!row || row.used_at || row.revoked_at || new Date(row.expires_at) <= now) return null;
  if (row.provider_profiles.user_id || row.provider_profiles.claimed) return null;
  return { display_name: row.provider_profiles.display_name, provider_type: row.provider_profiles.provider_type };
}

export async function claimProfile(token: string, userId: string): Promise<Result<{ profileId: string; slug: string }>> {
  const { data, error } = await supabaseAdmin().rpc("claim_provider_profile", { p_hash: hashToken(token), p_user: userId });
  if (error) throw new Error(`Could not claim profile: ${error.message}`);
  const outcome = data as { result: string; profile_id?: string; slug?: string };
  if (outcome.result === "has_profile") return { ok: false, status: 409, error: "You already have a profile" };
  if (outcome.result === "forbidden") return { ok: false, status: 403, error: "This account cannot claim a provider profile" };
  if (outcome.result !== "claimed") return { ok: false, status: 404, error: "This link is not valid." };
  await notifyLater(PROVIDER_TOPICS.claimed, { provider_profile_id: outcome.profile_id as string });
  return { ok: true, data: { profileId: outcome.profile_id as string, slug: outcome.slug as string } };
}
