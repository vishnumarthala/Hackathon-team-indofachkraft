// Ticket 021 FR-7: a short plain-text summary of a child's health profile for intake briefs (035), the AI
// scribe (038) and prescriptions (039). English on purpose: it feeds prompts and clinical documents, and
// free-text values are shown as entered. Pure; safe anywhere.
import { hasNoKnownAllergies, listedAllergies, type Allergy, type HealthProfile, type HealthSection } from "@/lib/health/schema";

export type HealthSummaryInput = Pick<HealthProfile, "allergies" | "medications" | "conditions">;

const NOT_RECORDED = "not recorded";

const clean = (parts: (string | undefined | null)[]) =>
  parts
    .map((p) => (p ?? "").trim())
    .filter(Boolean)
    .join(" ");

export function allergiesText(profile: HealthSummaryInput | null): string {
  if (!profile || profile.allergies.length === 0) return NOT_RECORDED;
  if (hasNoKnownAllergies(profile)) return "No known allergies";
  return listedAllergies(profile)
    .map((a) => {
      const extra = [a.severity !== "unknown" ? a.severity : "", a.reaction].filter(Boolean).join(", ");
      return extra ? `${a.substance} (${extra})` : a.substance;
    })
    .join(", ");
}

export function medicationsText(profile: HealthSummaryInput | null): string {
  if (!profile || profile.medications.length === 0) return NOT_RECORDED;
  return profile.medications.map((m) => clean([m.name, m.dose, m.frequency])).join(", ");
}

export function conditionsText(profile: HealthSummaryInput | null): string {
  if (!profile || profile.conditions.length === 0) return NOT_RECORDED;
  return profile.conditions.map((c) => (c.since ? `${c.name} (since ${c.since})` : c.name)).join(", ");
}

/** `Allergies: ...; Medicines: ...; Conditions: ...` (null = no profile yet). */
export function healthSummary(profile: HealthSummaryInput | null): string {
  return `Allergies: ${allergiesText(profile)}; Medicines: ${medicationsText(profile)}; Conditions: ${conditionsText(profile)}`;
}

export type HealthMarkdownLabels = {
  sections: Record<HealthSection, string>;
  notRecorded: string;
  noKnownAllergies: string;
  severity: Record<Allergy["severity"], string>;
  since: string;
};

export const ENGLISH_HEALTH_LABELS: HealthMarkdownLabels = {
  sections: {
    allergies: "Allergies",
    medications: "Medicines",
    conditions: "Conditions",
    birth_history: "Birth history",
    developmental_history: "Development so far",
    emergency_contact: "Emergency contact",
    blood_group: "Blood group",
  },
  notRecorded: "Not recorded",
  noKnownAllergies: "No known allergies",
  severity: { mild: "Mild", moderate: "Moderate", severe: "Severe", unknown: "Not sure" },
  since: "since",
};

/** Guardian free text must not turn into markdown structure (links, headings, HTML) when rendered. */
function md(value: string): string {
  return value.replace(/([\\`*_[\]{}()#+!|<>~-])/g, "\\$1").replace(/\n+/g, " ");
}

/** The profile as markdown, for read-only rendering (shared-records view, ticket 022 loader). */
export function healthProfileMarkdown(profile: HealthProfile, labels: HealthMarkdownLabels = ENGLISH_HEALTH_LABELS): string {
  const none = `_${md(labels.notRecorded)}_`;
  const list = (items: string[]) => (items.length ? items.map((i) => `- ${i}`).join("\n") : none);
  const allergies = hasNoKnownAllergies(profile)
    ? md(labels.noKnownAllergies)
    : list(
        listedAllergies(profile).map((a) =>
          [`**${md(a.substance)}**`, md(labels.severity[a.severity]), a.reaction ? md(a.reaction) : ""].filter(Boolean).join(" - "),
        ),
      );
  const medications = list(
    profile.medications.map((m) =>
      [`**${md(m.name)}**`, md(clean([m.dose, m.frequency])), m.since ? `${md(labels.since)} ${m.since}` : ""].filter(Boolean).join(" - "),
    ),
  );
  const conditions = list(
    profile.conditions.map((c) =>
      [`**${md(c.name)}**`, c.since ? `${md(labels.since)} ${c.since}` : "", c.notes ? md(c.notes) : ""].filter(Boolean).join(" - "),
    ),
  );
  const contact = [profile.emergency_contact_name, profile.emergency_contact_phone].filter(Boolean).map((v) => md(v as string)).join(", ");
  const blood = profile.blood_group ? (profile.blood_group === "unknown" ? md(labels.notRecorded) : md(profile.blood_group)) : none;
  const parts: [HealthSection, string][] = [
    ["allergies", allergies],
    ["medications", medications],
    ["conditions", conditions],
    ["birth_history", profile.birth_history ? md(profile.birth_history) : none],
    ["developmental_history", profile.developmental_history ? md(profile.developmental_history) : none],
    ["emergency_contact", contact || none],
    ["blood_group", blood],
  ];
  return parts.map(([section, body]) => `## ${md(labels.sections[section])}\n\n${body}`).join("\n\n");
}
