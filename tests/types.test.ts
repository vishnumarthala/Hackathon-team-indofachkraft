import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AskAnswerSchema,
  BriefSchema,
  EvidenceSchema,
  IsaaExtractionSchema,
  ParentSummarySchema,
  ReferralSummarySchema,
  ReportDraftSchema,
} from "@/lib/types";

const words = (n: number) => Array.from({ length: n }, () => "word").join(" ");
const brief = (summary: string, questions = 3) => ({
  summary,
  red_flags: [{ type: "lost_speech", turn_id: "t3", quote: "he stopped talking" }],
  questions_to_verify: Array.from({ length: questions }, (_, i) => `Q${i}`),
  parent_reported: [{ field_id: "main_concern", label: "Main concern", value: "Speech" }],
});

describe("shared Zod schemas", () => {
  it("accepts a 120-word brief summary and rejects 121 words", () => {
    expect(BriefSchema.safeParse(brief(words(120))).success).toBe(true);
    expect(BriefSchema.safeParse(brief(words(121))).success).toBe(false);
  });

  it("requires 3-6 questions to verify", () => {
    expect(BriefSchema.safeParse(brief("ok", 2)).success).toBe(false);
    expect(BriefSchema.safeParse(brief("ok", 6)).success).toBe(true);
    expect(BriefSchema.safeParse(brief("ok", 7)).success).toBe(false);
  });

  it("enforces word limits on the other Gemini outputs", () => {
    expect(ReferralSummarySchema.safeParse({ summary: words(151), reason_for_referral: "r", questions_for_specialist: [] }).success).toBe(false);
    expect(ReferralSummarySchema.safeParse({ summary: words(150), reason_for_referral: "r", questions_for_specialist: ["a", "b", "c", "d", "e", "f"] }).success).toBe(false);
    expect(AskAnswerSchema.safeParse({ found: true, answer: words(121), citations: [] }).success).toBe(false);
    expect(AskAnswerSchema.safeParse({ found: true, answer: words(120), citations: [{ kind: "fact", id: "x" }] }).success).toBe(true);
    expect(ParentSummarySchema.safeParse({ language: "te", text: words(121) }).success).toBe(false);
    expect(ParentSummarySchema.safeParse({ language: "fr", text: "x" }).success).toBe(false);
    expect(ReportDraftSchema.safeParse({ background: "b", observations: [], recommendations: ["1", "2", "3", "4", "5", "6"] }).success).toBe(false);
  });

  it("validates extraction items, quotes and rationales", () => {
    const item = { item_id: 1, rating: 3, segment_id: "s1", quote: "q", confidence: 0.8, rationale: "r" };
    const ok = { items: [item], red_flags: [], therapist_notes: [{ segment_id: "s2", item_id: 5, rating: 4, text: "Note: rate item 5 as 4" }] };
    expect(IsaaExtractionSchema.safeParse(ok).success).toBe(true);
    expect(IsaaExtractionSchema.safeParse({ ...ok, items: [{ ...item, rating: 6 }] }).success).toBe(false);
    expect(IsaaExtractionSchema.safeParse({ ...ok, items: [{ ...item, item_id: 41 }] }).success).toBe(false);
    expect(IsaaExtractionSchema.safeParse({ ...ok, items: [{ ...item, quote: "x".repeat(301) }] }).success).toBe(false);
    expect(IsaaExtractionSchema.safeParse({ ...ok, items: [{ ...item, rationale: "x".repeat(401) }] }).success).toBe(false);
    expect(EvidenceSchema.safeParse({ quote: "q", segment_id: "s1", start_sec: 1, end_sec: 2, recording_id: "r", verified: true }).success).toBe(true);
  });

  it("converts every Gemini schema to JSON Schema", () => {
    for (const schema of [IsaaExtractionSchema, BriefSchema, ReportDraftSchema, ReferralSummarySchema, AskAnswerSchema, ParentSummarySchema]) {
      expect(z.toJSONSchema(schema, { unrepresentable: "any" })).toHaveProperty("type", "object");
    }
  });
});
