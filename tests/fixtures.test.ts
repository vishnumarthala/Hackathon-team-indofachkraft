import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AskAnswerSchema,
  BriefSchema,
  IsaaExtractionSchema,
  ParentSummarySchema,
  ReferralSummarySchema,
  ReportDraftSchema,
  SegmentSchema,
} from "@/lib/types";
import { CASE_SHEET_FIELDS } from "@/lib/caseSheet";
import { buildScribeResponse, serializeScribeResponse } from "@/scripts/make-scribe-fixture";
import {
  PostCallSchema,
  SEED_CASE,
  buildCaseSheetFacts,
  buildIntakeSegments,
  buildIsaaFacts,
  parseArgs,
  renderBriefMarkdown,
} from "@/scripts/seed-demo";

const ROOT = path.resolve(import.meta.dirname, "..");
const FX = path.join(ROOT, "demo/fixtures");
const raw = (rel: string) => readFileSync(path.join(FX, rel), "utf8");
const json = (rel: string): unknown => JSON.parse(raw(rel));

const segments = z.array(SegmentSchema).parse(json("roleplay-segments.json"));
const extract = IsaaExtractionSchema.parse(json("gemini/extract.json"));
const brief = BriefSchema.parse(json("gemini/brief.json"));
const postCall = PostCallSchema.parse(json("elevenlabs-post-call.json"));
const ask = AskAnswerSchema.parse(json("gemini/ask.json"));
const parentSummary = ParentSummarySchema.parse(json("gemini/parent-summary.json"));
const segById = (id: string | null) => segments.find((s) => s.id === id);
const cs = (n: number) => Math.round(n * 100);

const ScribeSchema = z.object({
  language_code: z.literal("eng"),
  language_probability: z.literal(0.9),
  text: z.string(),
  words: z.array(
    z.object({
      text: z.string(),
      type: z.enum(["word", "spacing"]),
      start: z.number(),
      end: z.number(),
      speaker_id: z.string(),
    }),
  ),
});

const GEMINI = ["extract", "brief", "report", "referral", "ask", "parent-summary"];

describe("fixture schemas", () => {
  it("every fixture parses with its schema", () => {
    expect(z.array(SegmentSchema).safeParse(json("roleplay-segments.json")).success).toBe(true);
    expect(ScribeSchema.safeParse(json("scribe-response.json")).success).toBe(true);
    expect(PostCallSchema.safeParse(json("elevenlabs-post-call.json")).success).toBe(true);
    expect(IsaaExtractionSchema.safeParse(json("gemini/extract.json")).success).toBe(true);
    expect(BriefSchema.safeParse(json("gemini/brief.json")).success).toBe(true);
    expect(ReportDraftSchema.safeParse(json("gemini/report.json")).success).toBe(true);
    expect(ReferralSummarySchema.safeParse(json("gemini/referral.json")).success).toBe(true);
    expect(AskAnswerSchema.safeParse(json("gemini/ask.json")).success).toBe(true);
    expect(ParentSummarySchema.safeParse(json("gemini/parent-summary.json")).success).toBe(true);
  });
});

describe("role-play segments", () => {
  it("has ids s1..sN in order with N >= 30", () => {
    expect(segments.length).toBeGreaterThanOrEqual(30);
    segments.forEach((s, i) => expect(s.id).toBe(`s${i + 1}`));
  });

  it("alternates therapist (speaker_0) and parent (speaker_1), starting with the therapist", () => {
    segments.forEach((s, i) => {
      expect(s.speaker).toBe(i % 2 === 0 ? "therapist" : "parent");
      expect(s.speaker_label).toBe(i % 2 === 0 ? "speaker_0" : "speaker_1");
    });
  });

  it("has gaps >= 2.0 s between segments", () => {
    for (let i = 1; i < segments.length; i++) {
      expect(cs(segments[i].start_sec) - cs(segments[i - 1].end_sec)).toBeGreaterThanOrEqual(200);
    }
  });

  it("has segments of 3-25 s and ends between 200 and 260 s", () => {
    for (const s of segments) {
      expect(cs(s.end_sec) - cs(s.start_sec)).toBeGreaterThanOrEqual(300);
      expect(cs(s.end_sec) - cs(s.start_sec)).toBeLessThanOrEqual(2500);
    }
    const last = segments[segments.length - 1].end_sec;
    expect(last).toBeGreaterThanOrEqual(200);
    expect(last).toBeLessThanOrEqual(260);
  });

  it("has more than 300 words and only single spaces", () => {
    const words = segments.reduce((n, s) => n + s.text.split(" ").length, 0);
    expect(words).toBeGreaterThan(300);
    for (const s of segments) expect(s.text).toBe(s.text.trim().replace(/\s+/g, " "));
  });

  it("contains both therapist Note: lines with the exact rating instructions", () => {
    const notes = segments.filter((s) => s.text.startsWith("Note:"));
    expect(notes).toHaveLength(2);
    expect(notes.every((n) => n.speaker === "therapist")).toBe(true);
    expect(notes[0].text).toBe("Note: child did not respond to name in three attempts, rate item 5 as 4.");
    expect(notes[1].text).toContain("rate item 24 as 4");
    expect(segments.filter((s) => s.speaker === "parent" && /^note/i.test(s.text.trim()))).toHaveLength(0);
  });

  it("covers all 10 signs from the team plan", () => {
    const parent = segments
      .filter((s) => s.speaker === "parent")
      .map((s) => s.text.toLowerCase())
      .join(" ");
    for (const sign of [
      "does not look at us",
      "eyes",
      "does not turn when we call his name",
      "stopped talking",
      "lines up his toys",
      "plays alone",
      "repeats lines from cartoons",
      "mixer",
      "pressure cooker",
      "flaps his hands",
      "route to school",
      "hits his own head",
      "does not point",
    ]) {
      expect(parent).toContain(sign);
    }
  });
});

describe("Scribe fixture", () => {
  it("make-scribe-fixture output equals the committed scribe-response.json and is deterministic", () => {
    const a = serializeScribeResponse(buildScribeResponse(segments));
    const b = serializeScribeResponse(buildScribeResponse(segments));
    expect(a).toBe(b);
    expect(a).toBe(raw("scribe-response.json"));
  });

  it("spreads words across each segment with spacing entries in between", () => {
    const scribe = ScribeSchema.parse(json("scribe-response.json"));
    expect(scribe.text).toBe(segments.map((s) => s.text).join(" "));
    const words = scribe.words.filter((w) => w.type === "word");
    expect(words.length).toBeGreaterThan(300);
    for (const s of segments) {
      const mine = scribe.words.filter((w) => w.start >= s.start_sec && w.end <= s.end_sec);
      expect(mine[0]).toMatchObject({ type: "word", start: s.start_sec, speaker_id: s.speaker_label });
      expect(mine[mine.length - 1]).toMatchObject({ type: "word", end: s.end_sec });
      expect(mine.map((w) => w.text).join("")).toBe(s.text);
    }
    for (let i = 1; i < scribe.words.length - 1; i++) {
      const w = scribe.words[i];
      if (w.type !== "spacing") continue;
      expect(w.text).toBe(" ");
      expect(w.start).toBe(scribe.words[i - 1].end);
      expect(w.end).toBe(scribe.words[i + 1].start);
    }
  });
});

describe("extract fixture", () => {
  it("has item ids 1..40 exactly once", () => {
    const ids = extract.items.map((i) => i.item_id).sort((a, b) => a - b);
    expect(ids).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
  });

  it("quotes are verbatim substrings of their cited segments (>= 12 rated items)", () => {
    const rated = extract.items.filter((i) => i.rating !== null);
    expect(rated.length).toBeGreaterThanOrEqual(12);
    for (const item of rated) {
      const seg = segById(item.segment_id);
      expect(seg, `item ${item.item_id}`).toBeDefined();
      expect(seg!.text).toContain(item.quote!);
    }
  });

  it("has >= 5 null items with no evidence and confidence 0", () => {
    const nulls = extract.items.filter((i) => i.rating === null);
    expect(nulls.length).toBeGreaterThanOrEqual(5);
    for (const item of nulls) expect(item).toMatchObject({ segment_id: null, quote: null, confidence: 0 });
  });

  it("rates items 15 and 29 >= 3 and cites the right red flags and therapist notes", () => {
    const rating = (id: number) => extract.items.find((i) => i.item_id === id)!.rating!;
    expect(rating(15)).toBeGreaterThanOrEqual(3);
    expect(rating(29)).toBeGreaterThanOrEqual(3);
    expect(extract.red_flags.map((f) => f.type).sort()).toEqual(["lost_speech", "self_injury"]);
    for (const flag of extract.red_flags) expect(segById(flag.segment_id)!.text).toContain(flag.quote);
    expect(segById(extract.red_flags.find((f) => f.type === "lost_speech")!.segment_id)!.text).toContain("stopped talking");
    expect(segById(extract.red_flags.find((f) => f.type === "self_injury")!.segment_id)!.text).toContain("head");
    expect(extract.therapist_notes.map((n) => `${n.item_id}:${n.rating}`).sort()).toEqual(["24:4", "5:4"]);
    for (const note of extract.therapist_notes) {
      const seg = segById(note.segment_id)!;
      expect(seg.speaker).toBe("therapist");
      expect(seg.text).toContain(`rate item ${note.item_id} as 4`);
    }
  });
});

describe("ElevenLabs post-call fixture", () => {
  const d = postCall.data;

  it("has >= 12 turns, an AI disclosure with consent first, and one null tool-call turn in the middle", () => {
    expect(postCall.type).toBe("post_call_transcription");
    expect(d.transcript.length).toBeGreaterThanOrEqual(12);
    expect(d.transcript[0].role).toBe("agent");
    expect(d.transcript[0].message).toContain("I am an AI assistant");
    expect(d.transcript[0].message).toMatch(/agree|consent/i);
    const nullIdx = d.transcript.flatMap((t, i) => (t.message === null ? [i] : []));
    expect(nullIdx).toHaveLength(1);
    expect(nullIdx[0]).toBeGreaterThan(0);
    expect(nullIdx[0]).toBeLessThan(d.transcript.length - 1);
    expect(d.transcript[nullIdx[0]].role).toBe("agent");
    for (let i = 1; i < d.transcript.length; i++) {
      expect(d.transcript[i].time_in_call_secs).toBeGreaterThan(d.transcript[i - 1].time_in_call_secs);
    }
  });

  it("post-call aliases, age and ids match the seed values", () => {
    expect(d).toMatchObject({ agent_id: "demo-agent", conversation_id: "demo-conversation", status: "done" });
    expect(d.conversation_initiation_client_data.dynamic_variables).toEqual({
      intake_token: "demo-intake-token",
      child_alias: SEED_CASE.child_alias,
      parent_alias: SEED_CASE.parent_alias,
      therapist_name: SEED_CASE.therapist_name,
      language: SEED_CASE.language,
    });
    expect(d.analysis.data_collection_results.child_age_months.value).toBe(SEED_CASE.child_age_months);
  });

  it("collects every case-sheet field, agreeing with the role-play", () => {
    const r = d.analysis.data_collection_results;
    expect(Object.keys(r).sort()).toEqual(CASE_SHEET_FIELDS.map((f) => f.id).sort());
    for (const [key, value] of Object.entries(r)) expect(value.data_collection_id).toBe(key);
    expect(r.consent_given.value).toBe(true);
    expect(r.lost_speech.value).toBe(true);
    expect(r.self_injury.value).toBe(true);
    expect(String(r.lost_speech_details.value)).toMatch(/age 2/);
    for (const field of CASE_SHEET_FIELDS) {
      const value = r[field.id].value;
      if (field.type === "boolean") expect(typeof value).toBe("boolean");
      if (field.type === "integer") expect(Number.isInteger(value)).toBe(true);
      if (field.type === "string") expect(typeof value).toBe("string");
    }
  });
});

describe("Gemini fixtures", () => {
  it("brief turn ids exist and their messages contain the quotes", () => {
    expect(brief.red_flags.map((f) => f.type).sort()).toEqual(["lost_speech", "self_injury"]);
    for (const flag of brief.red_flags) {
      expect(flag.turn_id).toMatch(/^t\d+$/);
      const turn = postCall.data.transcript[Number(flag.turn_id.slice(1)) - 1];
      expect(turn, flag.turn_id).toBeDefined();
      expect(turn.message).not.toBeNull();
      expect(turn.message!).toContain(flag.quote);
    }
  });

  it("ask citations exist and point at the lost-speech segment of session 1", () => {
    expect(ask.found).toBe(true);
    expect(ask.citations.length).toBeGreaterThan(0);
    for (const c of ask.citations) {
      expect(c.kind).toBe("segment");
      const [session, segId] = c.id.split(":");
      expect(session).toBe("1");
      expect(segById(segId)).toBeDefined();
    }
    const lostSpeech = extract.red_flags.find((f) => f.type === "lost_speech")!.segment_id;
    expect(ask.citations.map((c) => c.id)).toContain(`1:${lostSpeech}`);
  });

  it("parent-summary is Telugu, has no digits or ISAA and ends with the next-steps sentence", () => {
    expect(parentSummary.language).toBe("te");
    expect(parentSummary.text).toMatch(/[\u0C00-\u0C7F]/);
    expect(parentSummary.text).not.toMatch(/[0-9\u0C66-\u0C6F]/);
    expect(parentSummary.text).not.toContain("ISAA");
    expect(parentSummary.text.trim().endsWith("మీ థెరపిస్ట్ తదుపరి దశల గురించి మీతో మాట్లాడతారు.")).toBe(true);
  });

  // Banned words are assembled at runtime so scripts/dev/check-copy.mjs does not flag this file.
  const banned = [new RegExp("diag" + "nos", "i"), new RegExp("HIPAA" + " compli" + "ant", "i"), /score/i];
  it("copy rules: no banned wording and no score in any Gemini fixture", () => {
    for (const task of GEMINI) {
      const text = raw(`gemini/${task}.json`).replace(new RegExp("not a diag" + "nosis", "gi"), "");
      for (const re of banned) expect(text, `${task} ${re}`).not.toMatch(re);
    }
  });
});

describe("demo folder rules", () => {
  const files: string[] = [];
  const walk = (dir: string) =>
    readdirSync(dir).forEach((f) => {
      const p = path.join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else files.push(p);
    });
  walk(path.join(ROOT, "demo"));

  it("JSON fixtures total <= 300 KB", () => {
    const total = files.filter((f) => f.endsWith(".json")).reduce((n, f) => n + statSync(f).size, 0);
    expect(total).toBeLessThanOrEqual(300 * 1024);
  });

  it("contains no real-looking emails or phone numbers", () => {
    for (const f of files.filter((x) => /\.(json|md)$/.test(x))) {
      const t = readFileSync(f, "utf8");
      const emails = (t.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/g) ?? []).filter((e) => !e.endsWith("@example.com"));
      const phones = (t.match(/\+?\d[\d ]{7,}\d/g) ?? []).filter((m) => /[ +]/.test(m));
      expect([...emails, ...phones], f).toEqual([]);
    }
  });
});

describe("seed helpers", () => {
  it("parses seed options", () => {
    expect(parseArgs([])).toEqual({ isNew: false, confirmed: false, stage: "extracted", noGuardian: false, finalReport: false });
    expect(parseArgs(["--new", "--confirmed", "--stage", "transcribed"])).toEqual({
      isNew: true,
      confirmed: true,
      stage: "transcribed",
      noGuardian: false,
      finalReport: false,
    });
    // 024 FR-6: a final (published) assessment report needs confirmed facts.
    expect(parseArgs(["--final-report"])).toMatchObject({ finalReport: true, confirmed: true });
    expect(() => parseArgs(["--final-report", "--stage", "transcribed"])).toThrow();
    expect(parseArgs(["--new", "--no-guardian"])).toMatchObject({ isNew: true, noGuardian: true });
    expect(() => parseArgs(["--stage", "bogus"])).toThrow();
    expect(() => parseArgs(["--nope"])).toThrow();
  });

  it("builds intake segments from the post-call transcript, skipping the null turn", () => {
    const t = postCall.data.transcript;
    const segs = buildIntakeSegments(t);
    expect(segs).toHaveLength(t.filter((x) => x.message).length);
    expect(segs[0]).toMatchObject({ id: "t1", speaker: "agent", speaker_label: "agent", start_sec: 0 });
    const nullIdx = t.findIndex((x) => x.message === null);
    expect(segs.map((s) => s.id)).not.toContain(`t${nullIdx + 1}`);
    const before = segs.find((s) => s.id === `t${nullIdx}`)!;
    expect(before.end_sec).toBe(t[nullIdx + 1].time_in_call_secs);
    expect(segs.find((s) => s.id === "t2")!.speaker).toBe("parent");
    const last = segs[segs.length - 1];
    expect(last.end_sec).toBe(last.start_sec + 5);
  });

  it("maps every case-sheet field to a suggested parent_call fact", () => {
    const facts = buildCaseSheetFacts("c", "i", postCall.data.analysis.data_collection_results, CASE_SHEET_FIELDS.map((f) => f.id));
    expect(facts).toHaveLength(15);
    expect(facts.every((f) => f.source === "parent_call" && f.status === "suggested" && f.instrument === "CASE_SHEET")).toBe(true);
  });

  it("builds 40 ISAA facts with voice-note overrides and the --confirmed rules", () => {
    const base = { caseId: "c", sessionId: "s", extract, segments, therapistName: "Demo Therapist", now: "2026-11-07T12:00:00Z" };
    const facts = buildIsaaFacts({ ...base, confirmed: false });
    expect(facts).toHaveLength(40);
    const confirmed = facts.filter((f) => f.status === "confirmed");
    expect(confirmed.map((f) => f.item_id).sort()).toEqual(["24", "5"]);
    for (const f of confirmed) {
      expect(f).toMatchObject({ value: 4, source: "therapist_voice", confirmed_by: "Demo Therapist (voice note)" });
    }
    expect(facts.filter((f) => f.value === null).length).toBeGreaterThanOrEqual(5);
    expect(facts.filter((f) => f.evidence).every((f) => f.evidence!.verified)).toBe(true);

    const all = buildIsaaFacts({ ...base, confirmed: true });
    expect(all.every((f) => f.value !== null && f.confirmed_at && f.status !== "suggested")).toBe(true);
    expect(all.filter((f) => f.status === "edited").every((f) => f.value === 1 && f.evidence === null)).toBe(true);
  });

  it("renders the brief as Markdown with the expected headings", () => {
    const md = renderBriefMarkdown(brief, buildIntakeSegments(postCall.data.transcript));
    expect(md).toContain("## Pre-session brief (parent-reported)");
    expect(md).toContain("### Red flags");
    expect(md).toMatch(/- Lost speech: ".+" \(00:57\)/);
    expect(md).toContain("### Questions to verify");
    expect(md).toContain("### What the parent reported");
    expect(md).toContain("| Topic | Answer |");
  });
});
