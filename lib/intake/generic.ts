// Ticket 035 FR-5: the generic pre-consult brief (non Child Development services). Pure helpers + schema; the
// processor is lib/intake/appointment-process.ts. The model writes the parent-reported content; the medicine and
// allergy check against the child's health profile (021) is computed here, deterministically, never by the model.
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import genericIntakeJson from "@/schemas/generic-intake.json";
import { formatTime } from "@/lib/intake/briefMarkdown";
import type { Segment } from "@/lib/types";

const text = (max: number) => z.string().trim().max(max);
const words = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .refine((s) => s.split(/\s+/).length <= max, `at most ${max} words`);

/** What Gemini returns (schemas/generic-intake.json `brief`). */
export const GenericIntakeBriefSchema = z.object({
  summary: words(120),
  reason_for_visit: text(600).min(1),
  history: text(1500),
  current_concerns: z.array(text(300).min(1)).max(8),
  medications: z.array(z.object({ name: text(120).min(1), details: text(200) })).max(20),
  allergies: z.array(z.object({ substance: text(120).min(1), reaction: text(200) })).max(20),
  red_flags: z.array(z.object({ turn_id: z.string().max(20), quote: text(300).min(1) })).max(10),
  questions_for_provider: z.array(text(300).min(1)).min(1).max(6),
});
export type GenericIntakeBrief = z.infer<typeof GenericIntakeBriefSchema>;

export type ProfileMatch = "in_profile" | "not_in_profile" | "profile_not_recorded";

export const HealthCheckSchema = z.object({
  recorded: z.boolean(),
  version: z.number().int().min(0),
  medications: z.array(z.object({ name: z.string(), match: z.enum(["in_profile", "not_in_profile", "profile_not_recorded"]) })),
  allergies: z.array(z.object({ substance: z.string(), match: z.enum(["in_profile", "not_in_profile", "profile_not_recorded"]) })),
  /** In the profile but not mentioned on the call. */
  profile_only: z.object({ medications: z.array(z.string()), allergies: z.array(z.string()) }),
});
export type HealthCheck = z.infer<typeof HealthCheckSchema>;

/** Stored in reports.content (kind generic_intake_brief). */
export const StoredGenericBriefSchema = GenericIntakeBriefSchema.extend({ health_check: HealthCheckSchema });
export type StoredGenericBrief = z.infer<typeof StoredGenericBriefSchema>;

export type GenericIntakeField = { id: string; type: "string" | "boolean"; label: string; description: string };
export const GENERIC_INTAKE_FIELDS = genericIntakeJson.fields as GenericIntakeField[];

export type CollectionResults = Record<string, { value?: string | number | boolean | null; rationale?: string | null }>;

export function loadGenericIntakePrompt(): string {
  return readFileSync(path.join(process.cwd(), "prompts", "generic-intake.md"), "utf8");
}

function display(value: unknown): string {
  if (value === null || value === undefined || value === "") return "(not collected)";
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}

/** Transcript lines `[t3 | 00:42 | PARENT] text`, the collected fields and the health profile summary (021). */
export function buildGenericIntakePrompt(segments: Segment[], results: CollectionResults | null | undefined, healthSummaryText: string): string {
  const lines = segments.map(
    (s) => `[${s.id} | ${formatTime(s.start_sec)} | ${s.speaker === "agent" ? "AI" : "PARENT"}] ${s.text}`,
  );
  const collected = GENERIC_INTAKE_FIELDS.filter((f) => results && Object.prototype.hasOwnProperty.call(results, f.id)).map(
    (f) => `${f.label}: ${display(results?.[f.id]?.value)}`,
  );
  return [
    "Intake call transcript:",
    ...lines,
    "",
    "Collected fields (parent-reported):",
    ...(collected.length ? collected : ["(none)"]),
    "",
    "Health profile on file (entered by the guardian; for comparison only):",
    healthSummaryText,
  ].join("\n");
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const sameItem = (a: string, b: string) => {
  const x = norm(a);
  const y = norm(b);
  return x !== "" && y !== "" && (x === y || x.includes(y) || y.includes(x));
};

export type ProfileFacts = {
  recorded: boolean;
  version: number;
  medications: { name: string }[];
  allergies: { substance: string }[];
};

/** FR-5: reported medicines/allergies vs the health profile (021 getPrescribingHealthFacts). */
export function checkAgainstProfile(brief: Pick<GenericIntakeBrief, "medications" | "allergies">, profile: ProfileFacts): HealthCheck {
  const match = (name: string, list: string[]): ProfileMatch =>
    !profile.recorded ? "profile_not_recorded" : list.some((p) => sameItem(p, name)) ? "in_profile" : "not_in_profile";
  const profileMeds = profile.medications.map((m) => m.name);
  const profileAllergies = profile.allergies.map((a) => a.substance);
  return {
    recorded: profile.recorded,
    version: profile.version,
    medications: brief.medications.map((m) => ({ name: m.name, match: match(m.name, profileMeds) })),
    allergies: brief.allergies.map((a) => ({ substance: a.substance, match: match(a.substance, profileAllergies) })),
    profile_only: {
      medications: profileMeds.filter((p) => !brief.medications.some((m) => sameItem(p, m.name))),
      allergies: profileAllergies.filter((p) => !brief.allergies.some((a) => sameItem(p, a.substance))),
    },
  };
}

/** Red flags must quote a PARENT line of this call. */
export function filterGenericRedFlags(brief: GenericIntakeBrief, segments: Segment[]): GenericIntakeBrief {
  const parent = new Set(segments.filter((s) => s.speaker !== "agent").map((s) => s.id));
  return { ...brief, red_flags: brief.red_flags.filter((f) => parent.has(f.turn_id)) };
}

const MATCH_LABEL: Record<ProfileMatch, string> = {
  in_profile: "in health profile",
  not_in_profile: "NOT in health profile",
  profile_not_recorded: "no health profile on file",
};

/** The Markdown the provider reads (reports.content_md). */
export function renderGenericBriefMarkdown(brief: StoredGenericBrief, segments: Segment[]): string {
  const lines = ["## Pre-consult brief (parent-reported)", "", brief.summary, "", "### Reason for visit", "", brief.reason_for_visit];
  lines.push("", "### Red flags", "");
  if (brief.red_flags.length === 0) lines.push("- None reported");
  for (const flag of brief.red_flags) {
    const seg = segments.find((s) => s.id === flag.turn_id);
    lines.push(`- "${flag.quote}"${seg ? ` (${formatTime(seg.start_sec)})` : ""}`);
  }
  lines.push("", "### History", "", brief.history || "Not reported.");
  lines.push("", "### Current concerns", "");
  if (brief.current_concerns.length === 0) lines.push("- None reported");
  brief.current_concerns.forEach((c) => lines.push(`- ${c}`));
  lines.push("", "### Medicines (checked against the health profile)", "");
  if (brief.medications.length === 0) lines.push("- None reported");
  brief.medications.forEach((m, i) => {
    const match = brief.health_check.medications[i]?.match ?? "profile_not_recorded";
    lines.push(`- ${m.name}${m.details ? ` (${m.details})` : ""}: ${MATCH_LABEL[match]}`);
  });
  if (brief.health_check.profile_only.medications.length) {
    lines.push(`- In the profile but not mentioned: ${brief.health_check.profile_only.medications.join(", ")}`);
  }
  lines.push("", "### Allergies (checked against the health profile)", "");
  if (brief.allergies.length === 0) lines.push("- None reported");
  brief.allergies.forEach((a, i) => {
    const match = brief.health_check.allergies[i]?.match ?? "profile_not_recorded";
    lines.push(`- ${a.substance}${a.reaction ? ` (${a.reaction})` : ""}: ${MATCH_LABEL[match]}`);
  });
  if (brief.health_check.profile_only.allergies.length) {
    lines.push(`- In the profile but not mentioned: ${brief.health_check.profile_only.allergies.join(", ")}`);
  }
  lines.push("", "### Questions for the provider", "");
  brief.questions_for_provider.forEach((q, i) => lines.push(`${i + 1}. ${q}`));
  return lines.join("\n") + "\n";
}
