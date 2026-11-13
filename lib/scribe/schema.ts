// Ticket 038 FR-4: structured AI scribe output (Gemini) and what is stored. Zod validates every model answer and every
// DEMO fixture; nothing invalid is stored. Pure, safe in the browser.
import { z } from "zod";
import { sectionKeys, type NoteTemplate } from "./templates";

export const CitationSchema = z.object({
  segment_id: z.string().min(1).max(40),
  quote: z.string().max(300),
});

export const StatementSchema = z.object({
  text: z.string().trim().min(1).max(1000),
  citations: z.array(CitationSchema).max(5),
});

export const GoalSuggestionSchema = z.object({
  goal_ref: z.string().regex(/^G\d{1,2}$/),
  suggested_value: z.number(),
  segment_id: z.string().min(1).max(40),
  quote: z.string().max(300),
  rationale: z.string().max(500),
});

/** Gemini output for a session note: sections of cited statements + progress suggestions for the given goals. */
export function noteOutputSchema(template: NoteTemplate) {
  return z.object({
    sections: z
      .array(z.object({ key: z.enum(sectionKeys(template)), statements: z.array(StatementSchema).max(15) }))
      .max(12),
    goal_suggestions: z.array(GoalSuggestionSchema).max(20),
  });
}
export type NoteOutput = z.infer<ReturnType<typeof noteOutputSchema>>;
export type GoalSuggestionOutput = z.infer<typeof GoalSuggestionSchema>;

// 039 FR-2 item shape, so 039 can prefill a prescription from the draft.
export const RX_FORMS = ["tablet", "syrup", "drops", "capsule", "other"] as const;

export const RxItemSchema = z.object({
  drug: z.string().trim().min(1).max(120),
  strength: z.string().max(60),
  form: z.enum(RX_FORMS),
  dose: z.string().max(60),
  frequency: z.string().max(60),
  duration_days: z.number().int().min(1).max(365),
  route: z.string().max(40),
  instructions: z.string().max(300).nullable(),
  citations: z.array(CitationSchema).max(5),
});

export const RxOutputSchema = z.object({
  items: z.array(RxItemSchema).max(15),
  advice: z.string().max(1000).nullable(),
  follow_up: z.string().max(300).nullable(),
});
export type RxOutput = z.infer<typeof RxOutputSchema>;

// ---------- stored shapes (reports.content, goal_progress_suggestions.evidence) ----------

export type StoredCitation = { segment_id: string; quote: string; start_sec: number; end_sec: number; verified: boolean };
export type StoredStatement = { text: string; citations: StoredCitation[] };
export type StoredSection = { key: string; heading: string; statements: StoredStatement[] };

export type SessionNoteContent = {
  template: NoteTemplate;
  title: string;
  sections: StoredSection[];
  health_summary: string | null;
};

export type RxItem = Omit<z.infer<typeof RxItemSchema>, "citations"> & { citations: StoredCitation[] };
export type RxDraftContent = {
  items: RxItem[];
  advice: string | null;
  follow_up: string | null;
  /** Allergies/medicines at drafting time (021), for the prescriber's review. */
  health_summary: string | null;
};

export type ProcessedGoalSuggestion = {
  goal_id: string;
  suggested_value: number;
  evidence: StoredCitation[];
  rationale: string;
};
