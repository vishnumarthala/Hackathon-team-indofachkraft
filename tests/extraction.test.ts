import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildExtractPrompt,
  computeFactWrites,
  loadExtractSystemPrompt,
  mergeVoiceNotes,
  normalizeText,
  parseVoiceNotes,
  postProcess,
  type ExistingFact,
} from "@/lib/extraction";
import { IsaaExtractionSchema, SegmentSchema, type IsaaExtraction, type Segment } from "@/lib/types";

const fixture = (rel: string) => JSON.parse(readFileSync(path.join(process.cwd(), "demo/fixtures", rel), "utf8"));
const segments = SegmentSchema.array().parse(fixture("roleplay-segments.json"));
const extract = IsaaExtractionSchema.parse(fixture("gemini/extract.json"));
const REC = "11111111-1111-4111-8111-111111111111";
const CASE = "22222222-2222-4222-8222-222222222222";

const seg = (id: string, speaker: Segment["speaker"], text: string, start = 0): Segment => ({
  id,
  speaker,
  speaker_label: speaker === "therapist" ? "speaker_0" : "speaker_1",
  start_sec: start,
  end_sec: start + 3,
  text,
});

const item = (over: Partial<IsaaExtraction["items"][number]> & { item_id: number }) => ({
  rating: 3 as const,
  segment_id: "a1",
  quote: "he lines up his cars",
  confidence: 0.9,
  rationale: "Parent-reported: lines up cars.",
  ...over,
});

const synthetic: Segment[] = [
  seg("a1", "parent", "Every day he lines up his cars, one by one!", 10),
  seg("a2", "therapist", "Note: rate item 7 as 2.", 20),
];

describe("normalizeText", () => {
  it("lower-cases, strips punctuation and collapses whitespace", () => {
    expect(normalizeText("  He SAID: \"amma,  nanna\"!\n")).toBe("he said amma nanna");
  });
});

describe("postProcess with the extract fixture", () => {
  const result = postProcess({ extraction: extract, segments, recordingId: REC });

  it("returns exactly 40 items in order with server timestamps", () => {
    expect(result.items.map((i) => i.item_id)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
    for (const i of result.items) {
      if (!i.evidence) continue;
      const s = segments.find((x) => x.id === i.evidence!.segment_id)!;
      expect(i.evidence.start_sec).toBe(s.start_sec);
      expect(i.evidence.end_sec).toBe(s.end_sec);
      expect(i.evidence.recording_id).toBe(REC);
    }
  });

  it("verifies the fixture quotes and never keeps evidence on unrated items", () => {
    const rated = result.items.filter((i) => i.rating !== null);
    expect(rated.length).toBeGreaterThanOrEqual(12);
    expect(rated.every((i) => i.evidence?.verified === true)).toBe(true);
    expect(result.items.filter((i) => i.rating === null && i.evidence !== null)).toEqual([]);
  });

  it("keeps the lost speech and self-injury red flags", () => {
    expect(result.red_flags.map((f) => [f.type, f.segment_id])).toEqual([
      ["lost_speech", "s10"],
      ["self_injury", "s30"],
    ]);
  });
});

describe("postProcess synthetic cases", () => {
  const run = (items: IsaaExtraction["items"], red_flags: IsaaExtraction["red_flags"] = []) =>
    postProcess({ extraction: { items, red_flags, therapist_notes: [] }, segments: synthetic, recordingId: REC });

  it("unknown segment -> rating null, confidence 0, no evidence", () => {
    const [first] = run([item({ item_id: 1, segment_id: "zz9" })]).items;
    expect(first).toMatchObject({ item_id: 1, rating: null, confidence: 0, evidence: null });
  });

  it("null segment or null quote -> no evidence", () => {
    const out = run([item({ item_id: 1, segment_id: null }), item({ item_id: 2, quote: null })]).items;
    expect(out[0]).toMatchObject({ rating: null, confidence: 0, evidence: null });
    expect(out[1]).toMatchObject({ rating: null, confidence: 0, evidence: null });
  });

  it("wrong quote keeps the rating unverified with confidence capped at 0.5", () => {
    const [first] = run([item({ item_id: 1, quote: "he never plays with cars" })]).items;
    expect(first.rating).toBe(3);
    expect(first.evidence).toMatchObject({ verified: false, segment_id: "a1", start_sec: 10, end_sec: 13 });
    expect(first.confidence).toBeLessThanOrEqual(0.5);
  });

  it("matching quote ignores case and punctuation", () => {
    const [first] = run([item({ item_id: 1, quote: "EVERY day, he lines up his cars" })]).items;
    expect(first.evidence?.verified).toBe(true);
    expect(first.confidence).toBe(0.9);
  });

  it("keeps the first entry for a duplicate item", () => {
    const out = run([item({ item_id: 4, rating: 2 }), item({ item_id: 4, rating: 5 })]).items;
    expect(out.filter((i) => i.item_id === 4)).toHaveLength(1);
    expect(out[3].rating).toBe(2);
  });

  it("fills missing items with null ratings", () => {
    const out = run([item({ item_id: 9 })]).items;
    expect(out).toHaveLength(40);
    expect(out.filter((i) => i.rating !== null).map((i) => i.item_id)).toEqual([9]);
    expect(out[0]).toMatchObject({ rating: null, confidence: 0, evidence: null });
  });

  it("drops red flags whose segment does not exist", () => {
    const flags = run([], [
      { type: "self_injury", segment_id: "a1", quote: "x", note: "n" },
      { type: "lost_speech", segment_id: "nope", quote: "x", note: "n" },
    ]).red_flags;
    expect(flags.map((f) => f.segment_id)).toEqual(["a1"]);
  });
});

describe("parseVoiceNotes", () => {
  it("finds the two roleplay notes", () => {
    expect(parseVoiceNotes(segments).map((n) => [n.item_id, n.rating, n.segment_id])).toEqual([
      [5, 4, "s7"],
      [24, 4, "s25"],
    ]);
    expect(parseVoiceNotes(segments)[0].text).toBe(segments.find((s) => s.id === "s7")!.text);
  });

  it("parses digits and English words with as/at/to", () => {
    const notes = parseVoiceNotes([
      seg("n1", "therapist", "Note: rate item twenty-four as five."),
      seg("n2", "therapist", "note - please rate item twenty four at two"),
      seg("n3", "therapist", "NOTE: Rate item 3 to 1"),
      seg("n4", "therapist", "Note: rate item forty as three, rate item nine as four"),
    ]);
    expect(notes.map((n) => [n.item_id, n.rating, n.segment_id])).toEqual([
      [3, 1, "n3"],
      [9, 4, "n4"],
      [24, 2, "n2"],
      [40, 3, "n4"],
    ]);
  });

  it("ignores parents, non-note lines and out-of-range values; last note wins", () => {
    const notes = parseVoiceNotes([
      seg("s1", "therapist", "Note: rate item twenty-four as five."),
      seg("s2", "parent", "Note: rate item 3 as 2"),
      seg("s3", "therapist", "Note: rate item 24 as 3"),
      seg("s4", "therapist", "I would rate item 6 as 2 later"),
      seg("s5", "therapist", "Note: rate item 41 as 2, rate item 7 as 6, rate item zero as 1"),
    ]);
    expect(notes.map((n) => [n.item_id, n.rating, n.segment_id])).toEqual([[24, 3, "s3"]]);
  });
});

describe("mergeVoiceNotes", () => {
  const regex = parseVoiceNotes(synthetic);

  it("adds valid Gemini notes only for items the regex did not find", () => {
    const merged = mergeVoiceNotes(
      regex,
      [
        { segment_id: "a2", item_id: 7, rating: 5, text: "Note: rate item 7 as 2." },
        { segment_id: "a2", item_id: 8, rating: 3, text: "Note" },
        { segment_id: "a1", item_id: 9, rating: 3, text: "parent segment" },
        { segment_id: "zz", item_id: 10, rating: 3, text: "unknown segment" },
        { segment_id: "a2", item_id: null, rating: 3, text: "no item" },
        { segment_id: "a2", item_id: 11, rating: null, text: "no rating" },
      ],
      synthetic,
    );
    expect(merged.map((n) => [n.item_id, n.rating, n.segment_id])).toEqual([
      [7, 2, "a2"],
      [8, 3, "a2"],
    ]);
  });

  it("the fixture's Gemini notes duplicate the regex notes", () => {
    const merged = mergeVoiceNotes(parseVoiceNotes(segments), extract.therapist_notes, segments);
    expect(merged.map((n) => [n.item_id, n.rating])).toEqual([
      [5, 4],
      [24, 4],
    ]);
  });
});

describe("computeFactWrites", () => {
  const processed = postProcess({ extraction: extract, segments, recordingId: REC });
  const notes = mergeVoiceNotes(parseVoiceNotes(segments), extract.therapist_notes, segments);
  const base = { processed, notes, segments, caseId: CASE, recordingId: REC, therapistName: "Demo Therapist", now: "2026-11-07T12:00:00.000Z" };

  it("new rows: value = ai_value = rating, voice notes confirmed", () => {
    const { rows, notesApplied } = computeFactWrites({ ...base, existing: [] });
    expect(rows).toHaveLength(40);
    expect(notesApplied).toBe(2);
    const r1 = rows.find((r) => r.item_id === "1")!;
    expect(r1).toMatchObject({ value: 4, ai_value: 4, source: "session", status: "suggested" });
    const r5 = rows.find((r) => r.item_id === "5")!;
    expect(r5).toMatchObject({
      value: 4,
      source: "therapist_voice",
      status: "confirmed",
      confirmed_by: "Demo Therapist (voice note)",
      confirmed_at: base.now,
      evidence: { segment_id: "s7", verified: true, start_sec: 42.43, end_sec: 46.78 },
    });
    expect(r5.ai_value).toBe(processed.items[4].rating);
  });

  it("re-extraction skips confirmed/edited rows and keeps the first AI value", () => {
    const existing: ExistingFact[] = [
      { item_id: "1", status: "edited", ai_value: 4 },
      { item_id: "2", status: "suggested", ai_value: 2 },
      { item_id: "3", status: "suggested", ai_value: null },
      { item_id: "5", status: "confirmed", ai_value: 3 },
    ];
    const { rows, notesApplied } = computeFactWrites({ ...base, existing });
    expect(rows.find((r) => r.item_id === "1")).toBeUndefined();
    expect(rows.find((r) => r.item_id === "5")).toBeUndefined();
    expect(rows.find((r) => r.item_id === "2")!.ai_value).toBe(2);
    expect(rows.find((r) => r.item_id === "3")!.ai_value).toBe(processed.items[2].rating);
    expect(notesApplied).toBe(1);
  });
});

describe("prompts", () => {
  it("system prompt carries the section 10 rules", () => {
    const system = loadExtractSystemPrompt();
    expect(system).toContain("You document; you never diagnose.");
    expect(system).toContain("Never invent quotes - copy them");
    expect(system).toMatch(/parent-reported/i);
    expect(system).toContain("therapist_notes");
    expect(system).toContain("red_flags");
  });

  it("user prompt lists 40 items, the scale and transcript lines", () => {
    const prompt = buildExtractPrompt(segments);
    expect(prompt).toMatch(/^1\. .+ \[Social relationship and reciprocity\]$/m);
    expect(prompt).toMatch(/^40\. .+ \[Cognitive component\]$/m);
    expect(prompt).toContain("1 = Rarely (up to 20%)");
    expect(prompt).toContain("[s7 | 00:42-00:46 | THERAPIST] Note: child did not respond");
    expect(prompt.split("\n").filter((l) => /^\[s\d+ \| \d\d:\d\d-\d\d:\d\d \| [A-Z]+\] /.test(l))).toHaveLength(36);
  });
});
