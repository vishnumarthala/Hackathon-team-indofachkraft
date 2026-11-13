// Ticket 038 FR-2: AI scribe templates, keyed by provider type (028). Pure, safe in the browser.
//
// - `child_dev_isaa`       - the existing Child Development path (005 transcription + 006 ISAA extraction), unchanged.
// - `therapy_session_note` - SLP, OT, ABA, special educator, physio: goals worked on, activities, child response,
//                            caregiver coaching, home-program suggestions, plan for next session.
// - `medical_consult_note` - dev-ped, psychiatrist, paediatrician, psychologist: history, observations, assessment
//                            impressions (phrased for the clinician to confirm), plan; prescribers also get an Rx
//                            draft (prompts/rx-draft.md) for 039 to sign.
// The provider's type picks the default on the upload form; the clinician can choose another `Session type`.
import { PROVIDER_TYPES, type ProviderType } from "@/lib/providers/constants";

export const SCRIBE_TEMPLATES = ["child_dev_isaa", "therapy_session_note", "medical_consult_note"] as const;
export type ScribeTemplate = (typeof SCRIBE_TEMPLATES)[number];
export type NoteTemplate = Exclude<ScribeTemplate, "child_dev_isaa">;

export const ISAA_TEMPLATE: ScribeTemplate = "child_dev_isaa";

export function isScribeTemplate(value: unknown): value is ScribeTemplate {
  return typeof value === "string" && (SCRIBE_TEMPLATES as readonly string[]).includes(value);
}

/** True for the templates handled by the AI scribe (not the ISAA extraction). */
export function isNoteTemplate(value: unknown): value is NoteTemplate {
  return isScribeTemplate(value) && value !== ISAA_TEMPLATE;
}

export const TEMPLATE_BY_PROVIDER_TYPE: Record<ProviderType, NoteTemplate> = {
  developmental_pediatrician: "medical_consult_note",
  child_psychiatrist: "medical_consult_note",
  child_psychologist: "medical_consult_note",
  pediatrician: "medical_consult_note",
  speech_language_pathologist: "therapy_session_note",
  occupational_therapist: "therapy_session_note",
  aba_therapist: "therapy_session_note",
  special_educator: "therapy_session_note",
  physiotherapist: "therapy_session_note",
};

/** Default `Session type` for a provider type; accounts without a provider profile keep the ISAA path. */
export function defaultTemplateFor(providerType: string | null | undefined): ScribeTemplate {
  if (providerType && (PROVIDER_TYPES as readonly string[]).includes(providerType)) {
    return TEMPLATE_BY_PROVIDER_TYPE[providerType as ProviderType];
  }
  return ISAA_TEMPLATE;
}

/** `recordings.kind` for a template (DB check `recordings_template_kind_check`). */
export function recordingKindFor(template: ScribeTemplate): "session" | "consult" {
  return template === "medical_consult_note" ? "consult" : "session";
}

export type NoteSectionSpec = { key: string; heading: string };

export type NoteTemplateSpec = {
  /** prompts/<file> system prompt. */
  prompt: string;
  /** DEMO_MODE Gemini fixture task: demo/fixtures/gemini/<task>.json. */
  geminiTask: string;
  /** DEMO_MODE transcription fixture (demo/fixtures/<file>), so each template has a matching role-play. */
  demoTranscript: string;
  title: string;
  sections: readonly NoteSectionSpec[];
  /** Whether prescribers also get an Rx draft. */
  rxDraft: boolean;
};

export const NOTE_TEMPLATES: Record<NoteTemplate, NoteTemplateSpec> = {
  therapy_session_note: {
    prompt: "session-note-therapy.md",
    geminiTask: "scribe-therapy",
    demoTranscript: "scribe-response-therapy.json",
    title: "Therapy session note",
    sections: [
      { key: "goals_worked_on", heading: "Goals worked on" },
      { key: "activities", heading: "Activities" },
      { key: "child_response", heading: "Child's response" },
      { key: "caregiver_coaching", heading: "Caregiver coaching" },
      { key: "home_program", heading: "Home-program suggestions" },
      { key: "plan_next_session", heading: "Plan for next session" },
    ],
    rxDraft: false,
  },
  medical_consult_note: {
    prompt: "session-note-medical.md",
    geminiTask: "scribe-medical",
    demoTranscript: "scribe-response-consult.json",
    title: "Medical consult note",
    sections: [
      { key: "history", heading: "History" },
      { key: "observations", heading: "Observations" },
      { key: "assessment_impressions", heading: "Assessment impressions (for the clinician to confirm)" },
      { key: "plan", heading: "Plan" },
    ],
    rxDraft: true,
  },
};

export const RX_PROMPT = "rx-draft.md";
export const RX_GEMINI_TASK = "scribe-rx";

export function sectionKeys(template: NoteTemplate): [string, ...string[]] {
  return NOTE_TEMPLATES[template].sections.map((s) => s.key) as [string, ...string[]];
}

/** DEMO_MODE transcription fixture for a recording's template (null = the default ISAA role-play). */
export function demoTranscriptFor(template: string | null | undefined): string | null {
  return isNoteTemplate(template) ? NOTE_TEMPLATES[template].demoTranscript : null;
}

/** 039 builds the prescription editor; the Rx draft card links here (`from_report_id` per 039 FR-3). */
export function rxReviewPath(caseId: string, reportId: string): string {
  return `/cases/${caseId}/prescriptions?from_report_id=${encodeURIComponent(reportId)}`;
}

/** Shown next to every AI output (FR-5). */
export const SCRIBE_LABEL = "Suggested by DoctorNearMe - the clinician decides";
export const IN_CLINIC_ONLY = "The AI scribe is available for in-clinic sessions only";
