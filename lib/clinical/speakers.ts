// Ticket 024 FR-5: speaker-role contract. Pure, safe in the browser.
//
// Stored values (recordings.speaker_map, segments[].speaker) keep their names, so no data is rewritten:
// - `therapist`   = the clinician of ANY provider type (psychologist, speech therapist, paediatrician, ...)
// - `parent`      = a guardian or caregiver of the child
// - `agent`       = the AI assistant (intake calls, voice agents)
// - `unknown`     = not attributed yet
// - `child`       = the child (new in 024)
// - `other_adult` = any other adult in the room, e.g. a teacher or relative (new in 024)
// Producers so far only write therapist/parent/agent/unknown. The swap (008) only swaps therapist <-> parent.
// UI labels come from i18n keys `speakers.<key>`; prompts keep the stored value (e.g. `THERAPIST`) unchanged.

export const SPEAKER_ROLES = ["therapist", "parent", "agent", "unknown", "child", "other_adult"] as const;
export type SpeakerRoleValue = (typeof SPEAKER_ROLES)[number];

/** i18n key (under `speakers`) per stored role: Clinician, Parent or caregiver, AI assistant, Unknown, Child, Other adult. */
export const SPEAKER_LABEL_KEYS = {
  therapist: "clinician",
  parent: "parentOrCaregiver",
  agent: "aiAssistant",
  unknown: "unknown",
  child: "child",
  other_adult: "otherAdult",
} as const satisfies Record<SpeakerRoleValue, string>;

/** English labels for server-side text; the UI uses the translated keys above. */
export const SPEAKER_LABELS_EN: Record<SpeakerRoleValue, string> = {
  therapist: "Clinician",
  parent: "Parent or caregiver",
  agent: "AI assistant",
  unknown: "Unknown",
  child: "Child",
  other_adult: "Other adult",
};

export function isSpeakerRole(value: unknown): value is SpeakerRoleValue {
  return typeof value === "string" && (SPEAKER_ROLES as readonly string[]).includes(value);
}

/** Roles the 008 speaker swap exchanges. Every other role is left untouched. */
export const SWAPPABLE_ROLES = ["therapist", "parent"] as const;
