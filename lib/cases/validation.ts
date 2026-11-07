import { z } from "zod";

export const LANGUAGES = ["en", "hi", "te"] as const;
export const DEFAULT_THERAPIST = "Demo Therapist";
export const PHONE_PATTERN = /^\+?[0-9 ]{7,20}$/;

const MSG = {
  childRequired: "Child alias is required",
  childMax: "Child alias must be at most 60 characters",
  age: "Age must be between 12 and 216 months",
  parentRequired: "Parent alias is required",
  parentMax: "Parent alias must be at most 60 characters",
  email: "Enter a valid email",
  phone: "Enter a valid phone number",
  language: "Choose English, Hindi or Telugu",
  therapistMax: "Therapist name must be at most 60 characters",
  facp: "FACP score must be between 0 and 100",
};

const NUMERIC_FIELDS = new Set(["child_age_months", "facp_score"]);
const CLEARABLE_FIELDS = new Set(["parent_email", "parent_phone"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toNumber(value: string): number | string {
  return /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value;
}

// Create: trim strings; blank strings count as "not given".
function cleanCreateBody(body: unknown): unknown {
  if (!isPlainObject(body)) return body;
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(body)) {
    let value = raw;
    if (typeof value === "string") {
      value = value.trim();
      if (value === "") continue;
      if (NUMERIC_FIELDS.has(key)) value = toNumber(value as string);
    }
    if (value === null) continue;
    out[key] = value;
  }
  return out;
}

// Update: trim strings; a blank or null email/phone clears the field.
function cleanUpdateBody(body: unknown): unknown {
  if (!isPlainObject(body)) return body;
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(body)) {
    let value = raw;
    if (typeof value === "string") {
      value = value.trim();
      if (value === "" && CLEARABLE_FIELDS.has(key)) value = null;
      else if (NUMERIC_FIELDS.has(key)) value = value === "" ? null : toNumber(value as string);
    }
    out[key] = value;
  }
  return out;
}

const alias = (required: string, max: string) =>
  z.string({ error: required }).min(1, { error: required }).max(60, { error: max });

const email = z.email({ error: MSG.email });
const phone = z.string({ error: MSG.phone }).regex(PHONE_PATTERN, { error: MSG.phone });
const language = z.enum(LANGUAGES, { error: MSG.language });
const facpScore = z
  .number({ error: MSG.facp })
  .int({ error: MSG.facp })
  .min(0, { error: MSG.facp })
  .max(100, { error: MSG.facp });

export const caseCreateSchema = z.preprocess(
  cleanCreateBody,
  z.object({
    child_alias: alias(MSG.childRequired, MSG.childMax),
    child_age_months: z
      .number({ error: MSG.age })
      .int({ error: MSG.age })
      .min(12, { error: MSG.age })
      .max(216, { error: MSG.age })
      .optional(),
    parent_alias: alias(MSG.parentRequired, MSG.parentMax),
    parent_email: email.optional(),
    parent_phone: phone.optional(),
    language: language.default("en"),
    therapist_name: z.string({ error: MSG.therapistMax }).max(60, { error: MSG.therapistMax }).default(DEFAULT_THERAPIST),
  }),
);

export const caseUpdateSchema = z.preprocess(
  cleanUpdateBody,
  z.object({
    facp_score: facpScore.nullable().optional(),
    language: language.optional(),
    parent_email: email.nullable().optional(),
    parent_phone: phone.nullable().optional(),
  }),
);

export type CaseCreateInput = z.output<typeof caseCreateSchema>;
export type CaseUpdateInput = z.output<typeof caseUpdateSchema>;
export const UPDATABLE_FIELDS = ["facp_score", "language", "parent_email", "parent_phone"] as const;

export function hasUpdates(input: CaseUpdateInput): boolean {
  return UPDATABLE_FIELDS.some((field) => input[field] !== undefined);
}

export function changedFields(
  current: Partial<Record<(typeof UPDATABLE_FIELDS)[number], unknown>>,
  input: CaseUpdateInput,
): (typeof UPDATABLE_FIELDS)[number][] {
  return UPDATABLE_FIELDS.filter((field) => input[field] !== undefined && input[field] !== (current[field] ?? null));
}

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}
