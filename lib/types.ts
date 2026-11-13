import { z } from "zod";
import { SPEAKER_ROLES } from "@/lib/clinical/speakers";

const wordCount = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;
const maxWords = (max: number) =>
  z.string().refine((text) => wordCount(text) <= max, { message: `Must be at most ${max} words` });

export const LanguageSchema = z.enum(["en", "hi", "te"]);
export type Language = z.infer<typeof LanguageSchema>;

// 024 FR-5: the speaker-role contract (meanings and labels in lib/clinical/speakers.ts).
export const SpeakerRoleSchema = z.enum(SPEAKER_ROLES);
export type SpeakerRole = z.infer<typeof SpeakerRoleSchema>;

export const SegmentSchema = z.object({
  id: z.string(),
  speaker: SpeakerRoleSchema,
  speaker_label: z.string(),
  start_sec: z.number(),
  end_sec: z.number(),
  text: z.string(),
});
export type Segment = z.infer<typeof SegmentSchema>;

export const EvidenceSchema = z.object({
  quote: z.string().max(300),
  segment_id: z.string(),
  start_sec: z.number(),
  end_sec: z.number(),
  recording_id: z.string(),
  verified: z.boolean(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export const IsaaRatingSchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]);
export type IsaaRating = z.infer<typeof IsaaRatingSchema>;

export const RedFlagTypeSchema = z.enum(["lost_speech", "self_injury", "other"]);
export type RedFlagType = z.infer<typeof RedFlagTypeSchema>;

export const FactValueSchema = z.union([z.number(), z.string(), z.boolean()]).nullable();
export type FactValue = z.infer<typeof FactValueSchema>;

export const FactRowSchema = z.object({
  id: z.string(),
  case_id: z.string(),
  recording_id: z.string(),
  instrument: z.enum(["ISAA", "CASE_SHEET"]),
  item_id: z.string(),
  value: FactValueSchema,
  ai_value: FactValueSchema,
  source: z.enum(["parent_call", "session", "therapist_voice"]),
  evidence: EvidenceSchema.nullable(),
  confidence: z.number().min(0).max(1).nullable(),
  rationale: z.string().nullable(),
  status: z.enum(["suggested", "confirmed", "edited"]),
  confirmed_by: z.string().nullable(),
  confirmed_at: z.string().nullable(),
  created_at: z.string(),
});
export type FactRow = z.infer<typeof FactRowSchema>;

const ItemIdSchema = z.number().int().min(1).max(40);
const DomainIdSchema = z.enum(["social", "emotional", "speech", "behaviour", "sensory", "cognitive"]);

export const IsaaExtractionSchema = z.object({
  items: z.array(
    z.object({
      item_id: ItemIdSchema,
      rating: IsaaRatingSchema.nullable(),
      segment_id: z.string().nullable(),
      quote: z.string().max(300).nullable(),
      confidence: z.number().min(0).max(1),
      rationale: z.string().max(400),
    }),
  ),
  red_flags: z.array(
    z.object({ type: RedFlagTypeSchema, segment_id: z.string(), quote: z.string().max(300), note: z.string() }),
  ),
  therapist_notes: z.array(
    z.object({
      segment_id: z.string(),
      item_id: ItemIdSchema.nullable(),
      rating: IsaaRatingSchema.nullable(),
      text: z.string(),
    }),
  ),
});
export type IsaaExtraction = z.infer<typeof IsaaExtractionSchema>;

export const BriefSchema = z.object({
  summary: maxWords(120),
  red_flags: z.array(z.object({ type: RedFlagTypeSchema, turn_id: z.string(), quote: z.string().max(300) })),
  questions_to_verify: z.array(z.string()).min(3).max(6),
  parent_reported: z.array(z.object({ field_id: z.string(), label: z.string(), value: z.string() })),
});
export type Brief = z.infer<typeof BriefSchema>;

export const ReportDraftSchema = z.object({
  background: z.string(),
  observations: z.array(z.object({ domain_id: DomainIdSchema, text: z.string(), item_ids: z.array(ItemIdSchema) })),
  recommendations: z.array(z.string()).max(5),
});
export type ReportDraft = z.infer<typeof ReportDraftSchema>;

export const ReferralSummarySchema = z.object({
  summary: maxWords(150),
  reason_for_referral: z.string(),
  questions_for_specialist: z.array(z.string()).max(5),
});
export type ReferralSummary = z.infer<typeof ReferralSummarySchema>;

export const AskAnswerSchema = z.object({
  found: z.boolean(),
  answer: maxWords(120),
  citations: z.array(z.object({ kind: z.enum(["fact", "segment"]), id: z.string() })),
});
export type AskAnswer = z.infer<typeof AskAnswerSchema>;

export const ParentSummarySchema = z.object({ language: LanguageSchema, text: maxWords(120) });
export type ParentSummary = z.infer<typeof ParentSummarySchema>;

export type CaseStatus = "booked" | "intake_done" | "in_assessment" | "referred";

export type CaseRow = {
  id: string;
  child_alias: string;
  child_age_months: number | null;
  parent_alias: string;
  parent_email: string | null;
  parent_phone: string | null;
  language: Language;
  therapist_name: string;
  org_id: string;
  created_by: string | null;
  facp_score: number | null;
  status: CaseStatus;
  intake_token: string | null;
  created_at: string;
  // 020: the child this care episode belongs to, and the intake link lifetime (FR-3, FR-6).
  child_id?: string;
  intake_token_expires_at?: string | null;
  intake_token_revoked_at?: string | null;
};

export type RecordingStatus = "created" | "transcribing" | "transcribed" | "extracting" | "extracted" | "failed";

export type RecordingRow = {
  id: string;
  case_id: string;
  kind: "intake_call" | "session" | "consult";
  session_number: number | null;
  storage_path: string | null;
  mime_type: string | null;
  duration_sec: number | null;
  status: RecordingStatus;
  error: string | null;
  external_id: string | null;
  speaker_map: Record<string, SpeakerRole>;
  segments: Segment[];
  red_flags: IsaaExtraction["red_flags"];
  language_code: string | null;
  created_at: string;
  /** 038: scribe template (`child_dev_isaa` = the ISAA path), uploader and optional appointment. */
  template?: "child_dev_isaa" | "therapy_session_note" | "medical_consult_note";
  uploaded_by?: string | null;
  appointment_id?: string | null;
};

export type ReportRow = {
  id: string;
  case_id: string;
  recording_id: string | null;
  kind: "pre_session_brief" | "assessment" | "parent_summary" | "session_note" | "rx_draft";
  content: unknown;
  content_md: string;
  audio_path: string | null;
  status: "draft" | "final";
  created_at: string;
  updated_at: string;
};

export type ReferralRow = {
  id: string;
  case_id: string;
  share_token: string;
  specialist_name: string;
  specialist_email: string;
  reason: string;
  packet: unknown;
  parent_consent: boolean;
  status: "sent" | "viewed" | "revoked";
  emailed: boolean;
  created_at: string;
  viewed_at: string | null;
  expires_at?: string;
};
