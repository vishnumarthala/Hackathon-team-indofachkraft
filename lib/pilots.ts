import { z } from "zod";

// Pilot sign-up validation shared by the landing form (client) and POST /api/pilot-signups (server).
// Ticket 014. Kept out of lib/types.ts on purpose (owned by 001, see system-design D-5).

export const PILOT_ROLES = ["therapist", "psychologist", "centre_owner", "parent", "other"] as const;
export type PilotRole = (typeof PILOT_ROLES)[number];

export const PILOT_ROLE_LABELS: Record<PilotRole, string> = {
  therapist: "Therapist",
  psychologist: "Child psychologist",
  centre_owner: "Centre owner / manager",
  parent: "Parent (interested in the pilot)",
  other: "Other",
};

export const NAME_MAX = 100;
export const COUNTRY_MAX = 60;
export const CENTRE_MAX = 100;
export const NOTE_MAX = 1000;

export type PilotMessages = Record<
  "name" | "nameMax" | "email" | "role" | "country" | "countryMax" | "centreMax" | "clinicians" | "noteMax",
  string
>;

// English messages (API responses); the book-demo form passes the viewer's translations (ticket 018).
export const MSG: PilotMessages = {
  name: "Name is required",
  nameMax: `Name must be at most ${NAME_MAX} characters`,
  email: "Enter a valid email",
  role: "Choose who you are",
  country: "Country is required",
  countryMax: `Country must be at most ${COUNTRY_MAX} characters`,
  centreMax: `Centre must be at most ${CENTRE_MAX} characters`,
  clinicians: "Clinicians must be between 1 and 1000",
  noteMax: `Note must be at most ${NOTE_MAX} characters`,
};

// Form fields arrive as strings; an empty or blank optional field means "not given".
const blankToUndefined = (v: unknown) =>
  v === null || (typeof v === "string" && v.trim() === "") ? undefined : v;

const optionalText = (max: number, message: string) =>
  z.preprocess(blankToUndefined, z.string().trim().max(max, message).optional());

export function pilotSignupSchema(msg: PilotMessages = MSG) {
  return z.object({
    name: z.string({ error: msg.name }).trim().min(1, msg.name).max(NAME_MAX, msg.nameMax),
    email: z
      .string({ error: msg.email })
      .trim()
      .toLowerCase()
      .pipe(z.email({ error: msg.email })),
    role: z.enum(PILOT_ROLES, { error: msg.role }),
    country: z.string({ error: msg.country }).trim().min(2, msg.country).max(COUNTRY_MAX, msg.countryMax),
    centre: optionalText(CENTRE_MAX, msg.centreMax),
    clinicians: z.preprocess(
      (v) => {
        const b = blankToUndefined(v);
        return typeof b === "string" ? Number(b) : b;
      },
      z
        .number({ error: msg.clinicians })
        .int(msg.clinicians)
        .min(1, msg.clinicians)
        .max(1000, msg.clinicians)
        .optional(),
    ),
    note: optionalText(NOTE_MAX, msg.noteMax),
    // Hidden honeypot field. Humans never see it; bots fill it.
    website: z.preprocess(blankToUndefined, z.string().max(500).optional()),
  });
}

export const PilotSignupSchema = pilotSignupSchema();

export type PilotSignupInput = z.input<typeof PilotSignupSchema>;
export type PilotSignup = z.output<typeof PilotSignupSchema>;

export function isHoneypotFilled(data: Pick<PilotSignup, "website">): boolean {
  return typeof data.website === "string" && data.website.trim() !== "";
}

/** One error message per top-level field (first issue wins), for showing under each form field. */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.length > 0 ? String(issue.path[0]) : "body";
    if (!(key in out)) out[key] = issue.message;
  }
  return out;
}
