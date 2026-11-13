// Ticket 021 FR-2: health profile shapes and validation. Safe anywhere (client and server).
import { z } from "zod";
import { normalizeIndianMobile } from "@/lib/family/phone";

export const BLOOD_GROUPS = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-", "unknown"] as const;
export type BloodGroup = (typeof BLOOD_GROUPS)[number];

export const ALLERGY_SEVERITIES = ["mild", "moderate", "severe", "unknown"] as const;
export type AllergySeverity = (typeof ALLERGY_SEVERITIES)[number];

/** The special allergy entry; allowed only as the single entry (NKA). */
export const NO_KNOWN_ALLERGIES = "No known allergies";

export const MAX_ENTRIES = 30;
export const LIMITS = {
  allergySubstance: 80,
  allergyReaction: 200,
  medicationName: 80,
  medicationDose: 40,
  medicationFrequency: 60,
  conditionName: 120,
  conditionNotes: 300,
  birthHistory: 2000,
  developmentalHistory: 4000,
  emergencyContactName: 80,
} as const;

/** Top-level fields, in display order. Audit and history record these names only, never values (NFR-3). */
export const HEALTH_FIELDS = [
  "blood_group",
  "allergies",
  "medications",
  "conditions",
  "birth_history",
  "developmental_history",
  "emergency_contact_name",
  "emergency_contact_phone",
] as const;
export type HealthField = (typeof HEALTH_FIELDS)[number];

/** UI sections (FR-4), in page order; the two emergency-contact fields form one section. */
export const HEALTH_SECTIONS = [
  "allergies",
  "medications",
  "conditions",
  "birth_history",
  "developmental_history",
  "emergency_contact",
  "blood_group",
] as const;
export type HealthSection = (typeof HEALTH_SECTIONS)[number];

export function sectionOf(field: string): HealthSection | null {
  const top = field.split(".")[0];
  if (top === "emergency_contact_name" || top === "emergency_contact_phone") return "emergency_contact";
  return (HEALTH_SECTIONS as readonly string[]).includes(top) ? (top as HealthSection) : null;
}

/** Field names (or error paths) -> unique sections in page order. */
export function sectionsOf(fields: readonly string[]): HealthSection[] {
  const set = new Set(fields.map(sectionOf).filter((s): s is HealthSection => s !== null));
  return HEALTH_SECTIONS.filter((s) => set.has(s));
}

const MONTH = /^(19|20)\d{2}-(0[1-9]|1[0-2])$/;
const E164 = /^\+[1-9]\d{6,14}$/;

const text = (max: number) => z.string().trim().max(max, `Use at most ${max} characters`);
const requiredText = (max: number) => text(max).min(1, "Required");

/** Trimmed; "" -> undefined (key left out). */
const blankToUndefined = (v: unknown) => {
  if (typeof v !== "string") return v;
  const trimmed = v.trim();
  return trimmed === "" ? undefined : trimmed;
};

/** "YYYY-MM" or empty. */
const since = z.preprocess(blankToUndefined, z.string().regex(MONTH, "Use YYYY-MM").optional());

/** Optional free text: trimmed, "" -> null. */
const optionalText = (max: number) =>
  z
    .union([z.string(), z.null()])
    .optional()
    .transform((v) => (typeof v === "string" ? v.trim() : ""))
    .pipe(z.string().max(max, `Use at most ${max} characters`))
    .transform((v) => (v === "" ? null : v));

export const AllergySchema = z.object({
  substance: requiredText(LIMITS.allergySubstance),
  reaction: text(LIMITS.allergyReaction).optional().default(""),
  severity: z.enum(ALLERGY_SEVERITIES).optional().default("unknown"),
});

export const MedicationSchema = z.object({
  name: requiredText(LIMITS.medicationName),
  dose: text(LIMITS.medicationDose).optional().default(""),
  frequency: text(LIMITS.medicationFrequency).optional().default(""),
  since,
});

export const ConditionSchema = z.object({
  name: requiredText(LIMITS.conditionName),
  since,
  notes: z.preprocess(blankToUndefined, z.string().max(LIMITS.conditionNotes, `Use at most ${LIMITS.conditionNotes} characters`).optional()),
});

export type Allergy = z.output<typeof AllergySchema>;
export type Medication = z.output<typeof MedicationSchema>;
export type Condition = z.output<typeof ConditionSchema>;

export function isNka(allergy: { substance: string }): boolean {
  return allergy.substance.trim().toLowerCase() === NO_KNOWN_ALLERGIES.toLowerCase();
}

/** FR-3: the 409 answer when the editor started from an older version. */
export const HEALTH_CONFLICT_ERROR = "This profile was changed by someone else. Reload to see the latest version.";

export const NKA_ERROR = "No known allergies cannot be combined with other allergies";

const AllergiesSchema = z
  .array(AllergySchema)
  .max(MAX_ENTRIES, `Add at most ${MAX_ENTRIES}`)
  .superRefine((list, ctx) => {
    if (list.length > 1 && list.some(isNka)) ctx.addIssue({ code: "custom", message: NKA_ERROR });
  })
  .transform((list): Allergy[] =>
    list.length === 1 && isNka(list[0]) ? [{ substance: NO_KNOWN_ALLERGIES, reaction: "", severity: "unknown" }] : list,
  );

const PhoneSchema = z
  .union([z.string(), z.null()])
  .optional()
  .transform((v, ctx) => {
    const raw = typeof v === "string" ? v.replace(/[\s()-]/g, "") : "";
    if (raw === "") return null;
    if (E164.test(raw)) return raw;
    const indian = normalizeIndianMobile(raw);
    if (indian) return `+${indian}`;
    ctx.addIssue({ code: "custom", message: "Use a phone number with country code, e.g. +91 98765 43210" });
    return z.NEVER;
  });

/** The editable profile (FR-2/FR-3). Unknown keys are dropped. */
export const HealthProfileFieldsSchema = z.object({
  blood_group: z.enum(BLOOD_GROUPS).nullable().optional().default(null),
  allergies: AllergiesSchema.optional().default([]),
  medications: z.array(MedicationSchema).max(MAX_ENTRIES, `Add at most ${MAX_ENTRIES}`).optional().default([]),
  conditions: z.array(ConditionSchema).max(MAX_ENTRIES, `Add at most ${MAX_ENTRIES}`).optional().default([]),
  birth_history: optionalText(LIMITS.birthHistory),
  developmental_history: optionalText(LIMITS.developmentalHistory),
  emergency_contact_name: optionalText(LIMITS.emergencyContactName),
  emergency_contact_phone: PhoneSchema,
});

/** PUT body: full profile + the version the editor started from (0 = no profile yet). */
export const HealthProfilePutSchema = HealthProfileFieldsSchema.extend({
  version: z.number().int().min(0),
});

export type HealthProfileFields = z.output<typeof HealthProfileFieldsSchema>;
export type HealthProfileInput = z.input<typeof HealthProfilePutSchema>;

/** A stored profile as returned by the APIs. `version: 0` = none saved yet. */
export type HealthProfile = HealthProfileFields & {
  child_id: string;
  version: number;
  updated_by: string | null;
  updated_at: string | null;
};

export function emptyHealthProfile(childId: string): HealthProfile {
  return {
    child_id: childId,
    blood_group: null,
    allergies: [],
    medications: [],
    conditions: [],
    birth_history: null,
    developmental_history: null,
    emergency_contact_name: null,
    emergency_contact_phone: null,
    version: 0,
    updated_by: null,
    updated_at: null,
  };
}

/** True when the guardian recorded "No known allergies". */
export function hasNoKnownAllergies(profile: Pick<HealthProfile, "allergies">): boolean {
  return profile.allergies.length === 1 && isNka(profile.allergies[0]);
}

/** Real allergies (without the NKA marker). */
export function listedAllergies(profile: Pick<HealthProfile, "allergies">): Allergy[] {
  return profile.allergies.filter((a) => !isNka(a));
}

export function severeAllergies(profile: Pick<HealthProfile, "allergies">): Allergy[] {
  return listedAllergies(profile).filter((a) => a.severity === "severe");
}

/** Zod issues -> `{ "allergies.0.substance": "Required" }` (full paths so the editor can point at a row). */
export function healthFieldErrors(error: z.ZodError): Record<string, string> {
  const details: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.length > 0 ? issue.path.map(String).join(".") : "body";
    details[key] ??= issue.message;
  }
  return details;
}
