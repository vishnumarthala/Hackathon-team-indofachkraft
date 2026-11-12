// Ticket 020: pure helpers for children and claim codes (no server imports; unit tested).
import { createHash, randomInt } from "node:crypto";
import { z } from "zod";
import { CONSENT_FEATURES, RELATIONSHIPS } from "@/lib/consent/features";

export const CLAIM_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const CLAIM_CODE_TTL_HOURS = 72;
export const CLAIM_FAILURES_PER_HOUR = 5;
export const CLAIM_INVALID = "This code is not valid";
export const CLAIM_RATE_LIMITED = "Too many attempts. Try again in an hour.";
export const CLAIM_CONFLICT = "This record is already linked";
export const DECLARATION_TEXT = "I am this child's parent or legal guardian.";

/** FR-12: 8 characters from the unambiguous alphabet, shown as `XXXX-XXXX`. */
export function generateClaimCode(): string {
  let raw = "";
  for (let i = 0; i < 8; i++) raw += CLAIM_CODE_ALPHABET[randomInt(CLAIM_CODE_ALPHABET.length)];
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

/** Upper-cases and strips spaces/dashes; null unless exactly 8 alphabet characters remain. */
export function normalizeClaimCode(input: string): string | null {
  const raw = input.toUpperCase().replace(/[\s-]/g, "");
  if (raw.length !== 8) return null;
  for (const ch of raw) if (!CLAIM_CODE_ALPHABET.includes(ch)) return null;
  return raw;
}

/** Only this hash is stored (never the code). */
export function hashClaimCode(normalized: string): string {
  return createHash("sha256").update(`claim:${normalized}`).digest("hex");
}

/** Age in whole years and months on `today` (both as calendar dates). */
export function ageParts(dateOfBirth: string, today: Date = new Date()): { years: number; months: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateOfBirth);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  let months = (today.getUTCFullYear() - y) * 12 + (today.getUTCMonth() + 1 - mo);
  if (today.getUTCDate() < d) months -= 1;
  if (months < 0) return null;
  return { years: Math.floor(months / 12), months: months % 12 };
}

/** Today's date in India (`YYYY-MM-DD`): consent and DOB dates are calendar dates in Asia/Kolkata. */
export function todayInIndia(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(now);
}

const isoDate = z
  .string({ error: "Enter a valid date" })
  .regex(/^\d{4}-\d{2}-\d{2}$/, { error: "Enter a valid date" })
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v), {
    error: "Enter a valid date",
  });

export const RelationshipSchema = z.enum(RELATIONSHIPS, { error: "Choose your relationship to the child" });
const declaration = z.literal(true, { error: "Please confirm the declaration" });

export const ChildCreateSchema = z.object({
  display_name: z
    .string({ error: "Enter the child's name" })
    .trim()
    .min(1, { error: "Enter the child's name" })
    .max(60, { error: "Name must be at most 60 characters" }),
  date_of_birth: isoDate
    .refine((v) => v <= todayInIndia(), { error: "Date of birth cannot be in the future" })
    .refine((v) => v >= "1990-01-01", { error: "Enter a valid date" })
    .nullish(),
  sex: z.enum(["female", "male", "other", "undisclosed"], { error: "Choose an option" }).nullish(),
  relationship: RelationshipSchema,
  declaration,
});

export const ClaimSchema = z.object({
  code: z.string({ error: CLAIM_INVALID }).max(40, { error: CLAIM_INVALID }),
  relationship: RelationshipSchema,
  declaration,
  existing_child_id: z.uuid({ error: "Choose a child" }).nullish(),
});

export const ConsentGrantSchema = z.object({
  feature: z.enum(CONSENT_FEATURES, { error: "Unknown permission" }),
  consent_document_id: z.uuid({ error: "Unknown consent text" }),
  agree: z.literal(true, { error: "Please agree to the text first" }),
});

export const PaperWithdrawSchema = z.object({
  feature: z.enum(CONSENT_FEATURES, { error: "Unknown permission" }),
  guardian_name: z
    .string({ error: "Enter the parent's name" })
    .trim()
    .min(1, { error: "Enter the parent's name" })
    .max(100, { error: "Name must be at most 100 characters" }),
  note: z.string().trim().max(500, { error: "Note must be at most 500 characters" }).optional(),
});

/** FR-12: WhatsApp text the provider sends with the code. */
export function claimMessage(c: { parent_alias: string; therapist_name: string; child_alias: string }, appUrl: string, code: string) {
  const url = `${appUrl.replace(/\/+$/, "")}/family/children/claim`;
  return (
    `Hello ${c.parent_alias}, this is ${c.therapist_name}'s team at DoctorNearMe. To see ${c.child_alias}'s care in ` +
    `your DoctorNearMe family app, open ${url} and enter the code ${code}. The code works once and expires in 72 hours.`
  );
}

export { isoDate as IsoDateSchema };
