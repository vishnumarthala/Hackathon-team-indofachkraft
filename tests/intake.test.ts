import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CASE_SHEET_FIELDS } from "@/lib/caseSheet";
import { briefStateFrom, formatTime, renderBriefMarkdown } from "@/lib/intake/briefMarkdown";
import {
  buildBriefPrompt,
  buildCaseSheetFacts,
  buildIntakeSegments,
  filterRedFlags,
  loadBriefPrompt,
  parsePostCallData,
  type PostCallData,
} from "@/lib/intake/process";
import { signPayload, verifySignature } from "@/lib/intake/signature";
import { BriefSchema, type Brief } from "@/lib/types";

const root = process.cwd();
const fixture = JSON.parse(readFileSync(path.join(root, "demo/fixtures/elevenlabs-post-call.json"), "utf8"));
const briefFixture: Brief = BriefSchema.parse(
  JSON.parse(readFileSync(path.join(root, "demo/fixtures/gemini/brief.json"), "utf8")),
);
const data: PostCallData = parsePostCallData(fixture.data);

describe("verifySignature (FR-2)", () => {
  const secret = "test-secret";
  const body = JSON.stringify({ type: "post_call_transcription", data: { a: 1 } });
  const now = Date.UTC(2026, 10, 7, 12, 0, 0);
  const t = Math.floor(now / 1000);

  it("valid: correct HMAC over '<t>.<rawBody>' with a fresh timestamp", () => {
    expect(verifySignature(body, signPayload(body, secret, t), secret, now)).toBe(true);
  });

  it("valid: header parts in any order", () => {
    const [tp, vp] = signPayload(body, secret, t).split(",");
    expect(verifySignature(body, `${vp},${tp}`, secret, now)).toBe(true);
  });

  it("invalid: wrong secret, modified body, flipped hex digit", () => {
    const header = signPayload(body, secret, t);
    expect(verifySignature(body, signPayload(body, "other-secret", t), secret, now)).toBe(false);
    expect(verifySignature(body + " ", header, secret, now)).toBe(false);
    const flipped = header.replace(/v0=(.)/, (_m, c: string) => `v0=${c === "a" ? "b" : "a"}`);
    expect(verifySignature(body, flipped, secret, now)).toBe(false);
  });

  it("old timestamp (> 30 min) is rejected; 29 min is accepted", () => {
    expect(verifySignature(body, signPayload(body, secret, t - 31 * 60), secret, now)).toBe(false);
    expect(verifySignature(body, signPayload(body, secret, t - 29 * 60), secret, now)).toBe(true);
  });

  it("future timestamp is rejected", () => {
    expect(verifySignature(body, signPayload(body, secret, t + 10 * 60), secret, now)).toBe(false);
  });

  it("missing parts: no header, no secret, no t, no v0, wrong scheme, malformed t, invalid hex", () => {
    const header = signPayload(body, secret, t);
    const hex = header.split("v0=")[1];
    expect(verifySignature(body, null, secret, now)).toBe(false);
    expect(verifySignature(body, "", secret, now)).toBe(false);
    expect(verifySignature(body, header, "", now)).toBe(false);
    expect(verifySignature(body, header, undefined, now)).toBe(false);
    expect(verifySignature(body, `v0=${hex}`, secret, now)).toBe(false);
    expect(verifySignature(body, `t=${t}`, secret, now)).toBe(false);
    expect(verifySignature(body, `t=${t},v1=${hex}`, secret, now)).toBe(false);
    expect(verifySignature(body, `t=abc,v0=${hex}`, secret, now)).toBe(false);
    expect(verifySignature(body, `t=${t}.5,v0=${hex}`, secret, now)).toBe(false);
    expect(verifySignature(body, `t=${t},v0=zz${hex.slice(2)}`, secret, now)).toBe(false);
    expect(verifySignature(body, `t=${t},v0=${hex.slice(0, 62)}`, secret, now)).toBe(false);
    expect(verifySignature(body, `t=${t},v0=${hex.toUpperCase()}`, secret, now)).toBe(false);
  });
});

describe("buildIntakeSegments (FR-3.3)", () => {
  const segments = buildIntakeSegments(data.transcript);

  it("keeps the original index in ids and skips the empty turn (index 8 -> no t9)", () => {
    expect(segments).toHaveLength(21);
    expect(segments.map((s) => s.id)).not.toContain("t9");
    expect(segments[0].id).toBe("t1");
    expect(segments[7].id).toBe("t8");
    expect(segments[8].id).toBe("t10");
    expect(segments.at(-1)?.id).toBe("t22");
  });

  it("maps speakers: agent -> agent, user -> parent, label = role", () => {
    expect(segments[0]).toMatchObject({ speaker: "agent", speaker_label: "agent" });
    expect(segments[1]).toMatchObject({ speaker: "parent", speaker_label: "user" });
  });

  it("end time = next kept turn's start, last turn = start + 5, text = message", () => {
    const t8 = segments.find((s) => s.id === "t8")!;
    const t10 = segments.find((s) => s.id === "t10")!;
    expect(t8.end_sec).toBe(t10.start_sec);
    const last = segments.at(-1)!;
    expect(last.end_sec).toBe(last.start_sec + 5);
    expect(t8.start_sec).toBe(data.transcript[7].time_in_call_secs);
    expect(t8.text).toBe(data.transcript[7].message);
  });

  it("whitespace-only and missing messages are skipped too", () => {
    const out = buildIntakeSegments([
      { role: "agent", message: "Hello", time_in_call_secs: 0 },
      { role: "user", message: "   ", time_in_call_secs: 2 },
      { role: "user", time_in_call_secs: 3 },
      { role: "user", message: "Hi", time_in_call_secs: 4 },
    ]);
    expect(out.map((s) => [s.id, s.start_sec, s.end_sec])).toEqual([
      ["t1", 0, 4],
      ["t4", 4, 9],
    ]);
  });
});

describe("buildCaseSheetFacts (FR-3.4)", () => {
  it("maps all 15 case-sheet fields from the fixture with value and rationale", () => {
    const facts = buildCaseSheetFacts(data.analysis?.data_collection_results);
    expect(facts).toHaveLength(15);
    expect(facts.map((f) => f.item_id)).toEqual(CASE_SHEET_FIELDS.map((f) => f.id));
    const age = facts.find((f) => f.item_id === "child_age_months")!;
    expect(age.value).toBe(fixture.data.analysis.data_collection_results.child_age_months.value);
    expect(age.rationale).toBe(fixture.data.analysis.data_collection_results.child_age_months.rationale);
  });

  it("ignores unknown keys, keeps null values, handles missing results", () => {
    const facts = buildCaseSheetFacts({
      main_concern: { value: null, rationale: "not said" },
      favourite_colour: { value: "blue", rationale: "x" },
    });
    expect(facts).toEqual([{ item_id: "main_concern", value: null, rationale: "not said" }]);
    expect(buildCaseSheetFacts(undefined)).toEqual([]);
    expect(buildCaseSheetFacts(null)).toEqual([]);
  });
});

describe("buildBriefPrompt (FR-3.5)", () => {
  it("formats transcript lines with AI/PARENT labels and the collected fields as '<label>: <value>'", () => {
    const segments = buildIntakeSegments(data.transcript);
    const prompt = buildBriefPrompt(segments, buildCaseSheetFacts(data.analysis?.data_collection_results));
    const t2 = segments[1];
    expect(prompt).toContain(`[t1 | ${formatTime(segments[0].start_sec)} | AI] ${segments[0].text}`);
    expect(prompt).toContain(`[t2 | ${formatTime(t2.start_sec)} | PARENT] ${t2.text}`);
    expect(prompt).toMatch(/^Age \(months\): 40$/m);
    expect(prompt).toContain("Age (months) = child_age_months");
  });
});

describe("filterRedFlags", () => {
  it("drops red flags whose turn_id is not an existing segment id", () => {
    const segments = buildIntakeSegments(data.transcript);
    const brief: Brief = {
      ...briefFixture,
      red_flags: [
        ...briefFixture.red_flags,
        { type: "other", turn_id: "t9", quote: "empty turn" },
        { type: "other", turn_id: "s3", quote: "made up" },
      ],
    };
    const filtered = filterRedFlags(brief, segments);
    expect(filtered.red_flags.map((f) => f.turn_id)).toEqual(["t8", "t17"]);
    expect(filtered.summary).toBe(brief.summary);
  });
});

describe("renderBriefMarkdown (FR-4)", () => {
  const segments = buildIntakeSegments(data.transcript);

  it("has the headings, labelled red flags with mm:ss, numbered questions and the report table", () => {
    const md = renderBriefMarkdown(briefFixture, segments);
    expect(md.startsWith("## Pre-session brief (parent-reported)\n")).toBe(true);
    expect(md).toContain("### Red flags");
    expect(md).toContain("### Questions to verify");
    expect(md).toContain("### What the parent reported");
    expect(md).toContain("| Topic | Answer |");
    const t8 = segments.find((s) => s.id === "t8")!;
    expect(md).toContain(`- Lost speech: "${briefFixture.red_flags[0].quote}" (${formatTime(t8.start_sec)})`);
    expect(md).toMatch(/- Self-injury: ".+" \(\d\d:\d\d\)/);
    expect(md).toContain(`1. ${briefFixture.questions_to_verify[0]}`);
    expect(md).toContain("| Age (months) | 40 |");
    expect(md).toContain("Parent-reported");
  });

  it("no red flags -> '- None reported'; pipes in cells are escaped; Other label", () => {
    const md = renderBriefMarkdown(
      { ...briefFixture, red_flags: [], parent_reported: [{ field_id: "x", label: "A|B", value: "c\nd" }] },
      segments,
    );
    expect(md).toContain("### Red flags\n\n- None reported");
    expect(md).toContain("| A\\|B | c d |");
    const other = renderBriefMarkdown({ ...briefFixture, red_flags: [{ type: "other", turn_id: "t2", quote: "q" }] }, segments);
    expect(other).toMatch(/- Other: "q" \(\d\d:\d\d\)/);
  });
});

describe("briefStateFrom (FR-8)", () => {
  const segments = buildIntakeSegments(data.transcript);
  it("none / failed / brief with labelled, timed red flags and status", () => {
    expect(briefStateFrom(null)).toEqual({ kind: "none" });
    expect(briefStateFrom({ recording: { segments }, report: null })).toEqual({ kind: "failed" });
    expect(briefStateFrom({ recording: { segments }, report: { content: { bad: true }, status: "draft" } })).toEqual({
      kind: "failed",
    });
    const state = briefStateFrom({ recording: { segments }, report: { content: briefFixture, status: "final" } });
    expect(state.kind).toBe("brief");
    if (state.kind !== "brief") return;
    expect(state.status).toBe("final");
    expect(state.brief.red_flags[0]).toEqual({
      label: "Lost speech",
      quote: briefFixture.red_flags[0].quote,
      time: formatTime(segments.find((s) => s.id === "t8")!.start_sec),
    });
  });
});

describe("prompts/brief.md (FR-5)", () => {
  const prompt = loadBriefPrompt();
  it("contains the system-design section 10 rules", () => {
    expect(prompt).toContain(
      "You document; you never diagnose. Use only the transcript/facts given. Never invent quotes - copy them word\nfor word from one segment.",
    );
    expect(prompt).toMatch(/parent-reported/i);
    expect(prompt).toContain("3 to 6");
    expect(prompt).toContain("turn_id");
    expect(prompt).toMatch(/word for word/);
  });
});

describe("parsePostCallData", () => {
  it("rejects a payload without an intake token or transcript", () => {
    expect(() => parsePostCallData({ conversation_id: "c1", transcript: [] })).toThrow(/Invalid post-call data/);
    expect(() => parsePostCallData({ ...fixture.data, transcript: "x" })).toThrow(/transcript/);
  });
});
