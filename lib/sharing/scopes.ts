// Ticket 022: cross-organisation sharing scopes and expiry options. Safe to import anywhere (client too).
// The same list is the `sharing_grants.scopes` check constraint in 20261113002200_care_team_sharing.sql.

export const SHARE_SCOPES = ["reports", "assessments", "iep", "home_program", "documents", "health_profile"] as const;

export type ShareScope = (typeof SHARE_SCOPES)[number];

export function isShareScope(value: unknown): value is ShareScope {
  return typeof value === "string" && (SHARE_SCOPES as readonly string[]).includes(value);
}

/** `expires_in_days` accepted by the grant API: 3 months, 12 months, or null = until the guardian stops it. */
export const SHARE_EXPIRY_DAYS = [90, 365] as const;
export type ShareExpiryDays = (typeof SHARE_EXPIRY_DAYS)[number] | null;
