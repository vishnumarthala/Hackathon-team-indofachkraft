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

export const MSG = {
  name: "Name is required",
  email: "Enter a valid email",
  role: "Choose who you are",
  country: "Country is required",
  clinicians: "Clinicians must be between 1 and 1000",
} as const;

// Form fields arrive as strings; an empty or blank optional field means "not given".
const blankToUndefined = (v: unknown) =>
  v === null || (typeof v === "string" && v.trim() === "") ? undefined : v;

const optionalText = (max: number, label: string) =>
  z.preprocess(
    blankToUndefined,
    z.string().trim().max(max, `${label} must be at most ${max} characters`).optional(),
  );

export const PilotSignupSchema = z.object({
  name: z
    .string({ error: MSG.name })
    .trim()
    .min(1, MSG.name)
    .max(100, "Name must be at most 100 characters"),
  email: z
    .string({ error: MSG.email })
    .trim()
    .toLowerCase()
    .pipe(z.email({ error: MSG.email })),
  role: z.enum(PILOT_ROLES, { error: MSG.role }),
  country: z
    .string({ error: MSG.country })
    .trim()
    .min(2, MSG.country)
    .max(60, "Country must be at most 60 characters"),
  centre: optionalText(100, "Centre"),
  clinicians: z.preprocess(
    (v) => {
      const b = blankToUndefined(v);
      return typeof b === "string" ? Number(b) : b;
    },
    z
      .number({ error: MSG.clinicians })
      .int(MSG.clinicians)
      .min(1, MSG.clinicians)
      .max(1000, MSG.clinicians)
      .optional(),
  ),
  note: optionalText(1000, "Note"),
  // Hidden honeypot field. Humans never see it; bots fill it.
  website: z.preprocess(blankToUndefined, z.string().max(500).optional()),
});

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

const berlinParts = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Berlin",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** `YYYY-MM-DD HH:mm` in Europe/Berlin. */
export function formatBerlin(value: string | Date): string {
  const parts = Object.fromEntries(
    berlinParts.formatToParts(new Date(value)).map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}
