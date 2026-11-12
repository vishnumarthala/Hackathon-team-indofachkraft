// Request schemas for ticket 028. Zod objects strip unknown keys, so client-sent `role`,
// `verification_status`, `can_prescribe`, `listed`, `user_id` etc. are ignored wherever they are not fields.
import { z } from "zod";
import { CERTIFICATE_MIME_TYPES, COUNCILS, MAX_CERTIFICATE_BYTES, PROFILE_LANGUAGES, PROVIDER_TYPES } from "./constants";

const text = (max: number, label: string) =>
  z
    .string()
    .trim()
    .max(max, { error: `${label} must be at most ${max} characters` });

const requiredText = (max: number, label: string) =>
  text(max, label).min(1, { error: `${label} is required` });

// Optional free text: "" clears the field (stored as null).
const optionalText = (max: number, label: string) =>
  text(max, label)
    .nullish()
    .transform((v) => (v ? v : null));

export const providerTypeSchema = z.enum(PROVIDER_TYPES, { error: "Choose your profession" });
export const councilSchema = z.enum(COUNCILS, { error: "Choose the council" });

// provider_type is optional: the claim flow creates an account for an existing (seeded) profile.
export const JoinSchema = z.object({
  provider_type: providerTypeSchema.optional(),
  full_name: requiredText(120, "Full name"),
  email: z.email({ error: "Enter a valid email" }).trim().toLowerCase().max(254),
  password: z
    .string({ error: "Password is required" })
    .min(8, { error: "Password must be at least 8 characters" })
    .max(72, { error: "Password must be at most 72 characters" }),
});

export const RegisterSchema = z.object({
  provider_type: providerTypeSchema,
  full_name: requiredText(120, "Full name"),
});

export const ProfileUpdateSchema = z
  .object({
    display_name: requiredText(120, "Name").optional(),
    provider_type: providerTypeSchema.optional(),
    qualifications: optionalText(300, "Qualifications").optional(),
    bio: optionalText(1500, "About").optional(),
    languages: z
      .array(z.enum(PROFILE_LANGUAGES, { error: "Unsupported language" }))
      .max(PROFILE_LANGUAGES.length)
      .transform((v) => [...new Set(v)])
      .optional(),
    years_experience: z
      .number({ error: "Years of experience must be a number" })
      .int({ error: "Years of experience must be a whole number" })
      .min(0, { error: "Years of experience must be 0-60" })
      .max(60, { error: "Years of experience must be 0-60" })
      .nullable()
      .optional(),
    time_zone: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .refine((tz) => {
        try {
          new Intl.DateTimeFormat("en", { timeZone: tz });
          return true;
        } catch {
          return false;
        }
      }, { error: "Unknown time zone" })
      .optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { error: "Nothing to update" });

const pincode = z.string().trim().regex(/^[1-9][0-9]{5}$/, { error: "Enter a 6-digit PIN code" });
const coordinate = (min: number, max: number) => z.number().min(min).max(max).nullable().optional();

export const LocationFields = z.object({
  name: requiredText(120, "Location name"),
  address_line1: requiredText(200, "Address"),
  address_line2: optionalText(200, "Address line 2").optional(),
  locality: requiredText(80, "Locality"),
  city: requiredText(80, "City").default("Hyderabad"),
  state: requiredText(80, "State").default("Telangana"),
  pincode,
  lat: coordinate(-90, 90),
  lng: coordinate(-180, 180),
});

export const LocationLinkSchema = z.union([
  z.object({ location_id: z.uuid({ error: "Choose a location" }) }),
  LocationFields.extend({ org_id: z.uuid({ error: "Choose an organisation" }) }),
]);

const certificateSizeError = { error: "File too large (max 10 MB)" };
export const CertificateUploadSchema = z.object({
  file_name: requiredText(255, "File name"),
  mime_type: z.enum(CERTIFICATE_MIME_TYPES, { error: "Upload a PDF, JPEG or PNG file" }),
  size_bytes: z.number(certificateSizeError).int(certificateSizeError).min(1, certificateSizeError).max(MAX_CERTIFICATE_BYTES, certificateSizeError),
});

export const CredentialSubmitSchema = z
  .object({
    council: councilSchema,
    state: optionalText(60, "State").optional(),
    registration_number: requiredText(60, "Registration number"),
    certificate_path: z.string({ error: "Upload your certificate" }).min(1, { error: "Upload your certificate" }).max(300),
  })
  .refine((v) => v.council !== "STATE_MEDICAL_COUNCIL" || Boolean(v.state), {
    error: "State is required for a State Medical Council registration",
    path: ["state"],
  });

export const ListingSchema = z.object({ listed: z.boolean({ error: "listed must be true or false" }) });

export const OrgPublicSchema = z
  .object({
    public_name: optionalText(120, "Public name").optional(),
    about: optionalText(2000, "About").optional(),
    phone_public: z
      .string()
      .trim()
      .max(20)
      .refine((v) => v === "" || /^\+?[0-9][0-9 -]{5,19}$/.test(v), { error: "Enter a valid phone number" })
      .nullish()
      .transform((v) => (v ? v : null))
      .optional(),
    website: z
      .string()
      .trim()
      .max(200)
      .refine((v) => v === "" || /^https?:\/\/\S+$/.test(v), { error: "Enter a full web address (https://...)" })
      .nullish()
      .transform((v) => (v ? v : null))
      .optional(),
    listed: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { error: "Nothing to update" });

export const SeedSchema = z
  .object({
    org_id: z.uuid().optional(),
    location_id: z.uuid().optional(),
    org_name: optionalText(120, "Organisation name").optional(),
    org_kind: z.enum(["centre", "solo"], { error: "Choose centre or solo practice" }).default("centre"),
    phone_public: optionalText(20, "Phone").optional(),
    website: optionalText(200, "Website").optional(),
    location: LocationFields.optional(),
    display_name: requiredText(120, "Provider name"),
    provider_type: providerTypeSchema,
    qualifications: optionalText(300, "Qualifications").optional(),
    bio: optionalText(1500, "About").optional(),
    languages: z.array(z.enum(PROFILE_LANGUAGES)).max(PROFILE_LANGUAGES.length).default([]),
    years_experience: z.number().int().min(0).max(60).nullable().optional(),
    registration_council: councilSchema.nullish(),
    registration_state: optionalText(60, "State").optional(),
    registration_number: optionalText(60, "Registration number").optional(),
    verified: z.boolean().default(false),
    verification_note: optionalText(1000, "Verification note").optional(),
    is_synthetic: z.boolean().default(false),
  })
  .superRefine((v, ctx) => {
    if (!v.org_id && !v.org_name) ctx.addIssue({ code: "custom", path: ["org_name"], message: "Organisation name is required" });
    if (v.org_id && !v.location_id && !v.location) {
      ctx.addIssue({ code: "custom", path: ["location"], message: "Choose or enter a location" });
    }
    if (!v.org_id && !v.location) ctx.addIssue({ code: "custom", path: ["location"], message: "Location is required" });
    if (v.verified) {
      if (!v.registration_council || !v.registration_number) {
        ctx.addIssue({ code: "custom", path: ["registration_number"], message: "Registration details are required to verify" });
      }
      if (v.registration_council === "OTHER" && !v.verification_note) {
        ctx.addIssue({ code: "custom", path: ["verification_note"], message: "Say what you checked" });
      }
    }
    if (v.registration_council === "STATE_MEDICAL_COUNCIL" && !v.registration_state) {
      ctx.addIssue({ code: "custom", path: ["registration_state"], message: "State is required" });
    }
  });

export const ReviewSchema = z.object({
  action: z.enum(["approve", "reject"], { error: "Choose approve or reject" }),
  note: optionalText(1000, "Note").optional(),
});

export const SuspendSchema = z.object({ note: requiredText(1000, "Note") });

export const ClaimTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
