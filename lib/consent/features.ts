// Ticket 020 FR-7: consent feature keys and the processing steps each one gates. Safe to import anywhere.

export const CONSENT_FEATURES = [
  "ai_intake_call",
  "session_recording",
  "ai_transcription",
  "ai_extraction",
  "ai_voice_note",
  "referral_share",
  "screen_result_save",
  "ai_follow_up",
] as const;

export type ConsentFeature = (typeof CONSENT_FEATURES)[number];

export function isConsentFeature(value: unknown): value is ConsentFeature {
  return typeof value === "string" && (CONSENT_FEATURES as readonly string[]).includes(value);
}

/** Where each feature is checked: when data is collected and again when queued/async work runs. */
export const FEATURE_GATES: Record<ConsentFeature, { collect: string[]; recheck: string[] }> = {
  ai_intake_call: {
    collect: ["POST /api/cases/:id/intake-link", "POST /api/intake/:token/start"],
    recheck: ["POST /api/intake/:token/complete", "ElevenLabs webhook processing", "brief generation (Gemini)"],
  },
  session_recording: {
    collect: ["POST /api/cases/:id/sessions"],
    recheck: ["upload completion (first transcription of a just-uploaded `created` recording)"],
  },
  ai_transcription: {
    collect: ["POST /api/sessions/:id/transcribe"],
    recheck: ["before the Scribe request is sent"],
  },
  ai_extraction: {
    collect: ["POST /api/sessions/:id/extract", "POST /api/sessions/:id/report"],
    recheck: ["before each Gemini request (extraction and report drafting)"],
  },
  ai_voice_note: {
    collect: ["POST /api/reports/:id/parent-voice-note"],
    recheck: ["before the TTS request"],
  },
  referral_share: {
    collect: ["POST /api/cases/:id/refer"],
    recheck: ["/specialist/:token page load", "POST /api/cases/:id/ask"],
  },
  screen_result_save: { collect: ["saving a public screen result to a child (ticket 033)"], recheck: [] },
  ai_follow_up: { collect: ["follow-up agent (ticket 040)"], recheck: ["each question (ticket 040)"] },
};

export const RELATIONSHIPS = ["mother", "father", "legal_guardian", "other_family"] as const;
export type Relationship = (typeof RELATIONSHIPS)[number];

export const CONSENT_REQUIRED_ERROR = "Guardian consent required";
export const CONSENT_HINT = "Ask the parent to allow this in their DoctorNearMe app.";

/** FR-14: client components append the hint to the FR-8 error text. */
export function withConsentHint(message: string): string {
  return message === CONSENT_REQUIRED_ERROR ? `${message}. ${CONSENT_HINT}` : message;
}
