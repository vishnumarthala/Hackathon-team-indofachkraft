// Ticket 028: provider profile vocabularies and pure rules. Safe in client and server code.

export const PROVIDER_TYPES = [
  "developmental_pediatrician",
  "child_psychiatrist",
  "child_psychologist",
  "speech_language_pathologist",
  "occupational_therapist",
  "aba_therapist",
  "special_educator",
  "physiotherapist",
  "pediatrician",
] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];

export const PRESCRIBER_TYPES: readonly ProviderType[] = ["developmental_pediatrician", "child_psychiatrist", "pediatrician"];

export const COUNCILS = ["NMC", "STATE_MEDICAL_COUNCIL", "RCI", "OTHER"] as const;
export type Council = (typeof COUNCILS)[number];

export const PROFILE_LANGUAGES = ["en", "hi", "te", "ur", "ta", "kn", "mr"] as const;
export type ProfileLanguage = (typeof PROFILE_LANGUAGES)[number];

export const VERIFICATION_STATUSES = ["unverified", "pending", "verified", "rejected", "suspended"] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export const CLAIM_TTL_DAYS = 14;
export const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
export const MAX_CERTIFICATE_BYTES = 10 * 1024 * 1024;
export const PHOTO_BUCKET = "provider-photos";
export const CREDENTIALS_BUCKET = "credentials";
export const CERTIFICATE_MIME_TYPES = ["application/pdf", "image/jpeg", "image/png"] as const;
export type CertificateMime = (typeof CERTIFICATE_MIME_TYPES)[number];

/** Mirrors SQL `provider_prescriber_rule` (D-3): prescriber type + verified + medical council. */
export function canPrescribe(type: string | null, status: string | null, council: string | null): boolean {
  return (
    PRESCRIBER_TYPES.includes(type as ProviderType) &&
    status === "verified" &&
    (council === "NMC" || council === "STATE_MEDICAL_COUNCIL")
  );
}

/** Last four characters only, e.g. `••••1234` (FR-7). */
export function maskRegistrationNumber(value: string | null): string | null {
  if (!value) return null;
  return `••••${value.trim().slice(-4)}`;
}

/** Public register a platform admin searches to check a registration (FR-4); none for OTHER. */
export function registerSearchUrl(council: string | null): string | null {
  switch (council) {
    case "NMC":
    case "STATE_MEDICAL_COUNCIL":
      // State medical councils feed the NMC Indian Medical Register, which searches them all.
      return "https://www.nmc.org.in/information-desk/indian-medical-register/";
    case "RCI":
      return "https://rehabcouncil.nic.in/";
    default:
      return null;
  }
}

/** URL slug from a display name: `[a-z0-9-]`, at most 80 chars, with a suffix for uniqueness. */
export function profileSlug(name: string, suffix: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return `${base || "provider"}-${suffix}`;
}
