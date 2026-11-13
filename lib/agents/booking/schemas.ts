// Ticket 034 FR-3 / NFR-2: request schemas of the agent's server tools. Strict: any key outside the schema (for
// example `child_name`, `phone`) is rejected with 400, so personal data cannot reach the tools. The agent's LLM fills
// these from the conversation, so enum values are normalised (case, spaces, common synonyms) before validation.
import { z } from "zod";
import { isValidDate } from "@/lib/booking/time";
import { DIRECTORY_TYPES } from "@/lib/geo/constants";
import { PROFILE_LANGUAGES } from "@/lib/providers/constants";
import { PARTS_OF_DAY } from "./constants";

/** The per-conversation token: 32 random bytes, base64url. */
export const BOOKING_SESSION_RE = /^[A-Za-z0-9_-]{43}$/;

const slug = (value: unknown) =>
  typeof value === "string"
    ? value
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/g, "_")
    : value;

const TYPE_SYNONYMS: Record<string, string> = {
  speech_therapist: "speech_language_pathologist",
  speech_therapy: "speech_language_pathologist",
  speech_language_therapist: "speech_language_pathologist",
  slp: "speech_language_pathologist",
  ot: "occupational_therapist",
  occupational_therapy: "occupational_therapist",
  psychologist: "child_psychologist",
  psychiatrist: "child_psychiatrist",
  developmental_paediatrician: "developmental_pediatrician",
  paediatrician: "pediatrician",
  aba: "aba_therapist",
  special_education: "special_educator",
  physio: "physiotherapist",
  physiotherapy: "physiotherapist",
  center: "centre",
  therapy_centre: "centre",
};

const LANGUAGE_NAMES: Record<string, string> = {
  english: "en",
  hindi: "hi",
  telugu: "te",
  urdu: "ur",
  tamil: "ta",
  kannada: "kn",
  marathi: "mr",
};

const MODE_SYNONYMS: Record<string, string> = {
  clinic: "in_clinic",
  in_person: "in_clinic",
  offline: "in_clinic",
  online: "video",
  video_call: "video",
  either: "any",
};

const normalised = (map: Record<string, string>) => (value: unknown) => {
  const s = slug(value);
  return typeof s === "string" ? (map[s] ?? s) : s;
};

const sessionField = z.string().regex(BOOKING_SESSION_RE, "Invalid booking_session");
const uuid = z.uuid({ error: "Must be an id from an earlier tool result" });
const serviceMode = z.preprocess(normalised(MODE_SYNONYMS), z.enum(["in_clinic", "video"], { error: "service_mode must be in_clinic or video" }));

export const SearchProvidersSchema = z.strictObject({
  booking_session: sessionField,
  locality_text: z
    .string()
    .trim()
    .min(2, { error: "Say a locality or PIN code in Hyderabad" })
    .max(100)
    // A long digit run is a phone number, not a place (PIN codes have 6 digits).
    .refine((v) => !/\d{7,}/.test(v.replace(/[\s-]/g, "")), { error: "Send only a locality or PIN code" }),
  type: z.preprocess(normalised(TYPE_SYNONYMS), z.enum(DIRECTORY_TYPES, { error: "Unknown provider type" })).optional(),
  language: z.preprocess(normalised(LANGUAGE_NAMES), z.enum(PROFILE_LANGUAGES, { error: "Unknown language" })).optional(),
  mode: z.preprocess(normalised(MODE_SYNONYMS), z.enum(["in_clinic", "video", "any"], { error: "mode must be in_clinic, video or any" })).optional(),
});

export const GetSlotsSchema = z.strictObject({
  booking_session: sessionField,
  profile_id: uuid,
  service_mode: serviceMode,
  date_from: z.string().trim().refine(isValidDate, { error: "Use YYYY-MM-DD" }),
  part_of_day: z.preprocess(slug, z.enum(PARTS_OF_DAY, { error: "part_of_day must be morning, afternoon or evening" })).optional(),
});

export const HoldSlotSchema = z.strictObject({
  booking_session: sessionField,
  profile_id: uuid,
  service_id: uuid,
  start: z.iso.datetime({ offset: true, error: "start must be the exact start from get_slots" }),
  /** 042 FR-2a: true only after the parent said they understand the provider is a demo profile. */
  demo_acknowledged: z.boolean().optional(),
});

export const TOOL_SCHEMAS = {
  search_providers: SearchProvidersSchema,
  get_slots: GetSlotsSchema,
  hold_slot: HoldSlotSchema,
} as const;

export type SearchProvidersInput = z.output<typeof SearchProvidersSchema>;
export type GetSlotsInput = z.output<typeof GetSlotsSchema>;
export type HoldSlotInput = z.output<typeof HoldSlotSchema>;
