import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildSegments, formatTime, mapSpeakers, toPromptLines, type ScribeWord } from "@/lib/transcript";
import type { Segment } from "@/lib/types";

const FIXTURES = path.resolve("demo/fixtures");
const scribeFile = path.join(FIXTURES, "scribe-response.json");
const roleplayFile = path.join(FIXTURES, "roleplay-segments.json");
const haveFixtures = existsSync(scribeFile) && existsSync(roleplayFile);

const w = (text: string, start: number, end: number, speaker_id = "speaker_0"): ScribeWord => ({
  text,
  start,
  end,
  type: "word",
  speaker_id,
});
const sp = (start: number, end: number, speaker_id = "speaker_0"): ScribeWord => ({
  text: " ",
  start,
  end,
  type: "spacing",
  speaker_id,
});

describe("buildSegments + mapSpeakers on the Scribe fixture (ticket 002)", () => {
  // Activates once 002's fixtures are merged; until then it is reported as skipped.
  it.skipIf(!haveFixtures)("rebuilds demo/fixtures/roleplay-segments.json exactly", () => {
    const scribe = JSON.parse(readFileSync(scribeFile, "utf8")) as { words: ScribeWord[] };
    const expected = JSON.parse(readFileSync(roleplayFile, "utf8")) as Segment[];
    const { segments } = mapSpeakers(buildSegments(scribe.words));

    expect(segments).toHaveLength(expected.length);
    segments.forEach((s, i) => {
      const e = expected[i];
      expect({ id: s.id, speaker: s.speaker, speaker_label: s.speaker_label, text: s.text }).toEqual({
        id: e.id,
        speaker: e.speaker,
        speaker_label: e.speaker_label,
        text: e.text,
      });
      expect(Math.abs(s.start_sec - e.start_sec)).toBeLessThanOrEqual(0.01);
      expect(Math.abs(s.end_sec - e.end_sec)).toBeLessThanOrEqual(0.01);
    });
  });
});

describe("buildSegments", () => {
  it("returns [] for an empty word list", () => {
    expect(buildSegments([])).toEqual([]);
    expect(mapSpeakers([])).toEqual({ segments: [], speaker_map: {} });
  });

  it("joins words and spacing of one speaker, trims text, uses first/last word times", () => {
    const segs = buildSegments([sp(0, 0.1), w("Hello", 0.1, 0.5), sp(0.5, 0.6), w("there.", 0.6, 1.0), sp(1.0, 1.1)]);
    expect(segs).toEqual([
      { id: "s1", speaker: "unknown", speaker_label: "speaker_0", start_sec: 0.1, end_sec: 1.0, text: "Hello there." },
    ]);
  });

  it("splits on speaker change", () => {
    const segs = buildSegments([w("Hi", 0, 0.5), sp(0.5, 0.6), w("Hello", 0.6, 1, "speaker_1")]);
    expect(segs.map((s) => [s.id, s.speaker_label, s.text])).toEqual([
      ["s1", "speaker_0", "Hi"],
      ["s2", "speaker_1", "Hello"],
    ]);
  });

  it("splits on a gap > 1.5 s but not on exactly 1.5 s", () => {
    const segs = buildSegments([w("one", 0, 1), w("two", 2.5, 3), w("three", 4.51, 5)]);
    expect(segs.map((s) => s.text)).toEqual(["onetwo", "three"]);
    expect(segs[1]).toMatchObject({ start_sec: 4.51, end_sec: 5 });
  });

  it("splits when a segment would last longer than 30 s", () => {
    const words: ScribeWord[] = [];
    for (let t = 0; t < 40; t += 1) {
      words.push(w("x", t, t + 0.9));
      words.push(sp(t + 0.9, t + 1));
    }
    const segs = buildSegments(words);
    expect(segs).toHaveLength(2);
    expect(segs[0]).toMatchObject({ start_sec: 0, end_sec: 29.9 });
    expect(segs[1]).toMatchObject({ id: "s2", start_sec: 30 });
    expect(segs.every((s) => s.end_sec - s.start_sec <= 30)).toBe(true);
  });

  it("keeps audio events in the text", () => {
    const segs = buildSegments([
      w("Look", 0, 0.4),
      sp(0.4, 0.5),
      { text: "(laughs)", start: 0.5, end: 1, type: "audio_event", speaker_id: "speaker_0" },
    ]);
    expect(segs[0].text).toBe("Look (laughs)");
  });
});

describe("mapSpeakers", () => {
  const seg = (id: string, label: string, text: string): Segment => ({
    id,
    speaker: "unknown",
    speaker_label: label,
    start_sec: 0,
    end_sec: 1,
    text,
  });

  it("makes the speaker who says 'Note' the therapist, even if they speak second", () => {
    const { segments, speaker_map } = mapSpeakers([
      seg("s1", "speaker_1", "He does not look at me."),
      seg("s2", "speaker_0", "  note: rate item 5 as 4"),
    ]);
    expect(speaker_map).toEqual({ speaker_1: "parent", speaker_0: "therapist" });
    expect(segments.map((s) => s.speaker)).toEqual(["parent", "therapist"]);
  });

  it("falls back to the first segment's speaker as therapist", () => {
    const { speaker_map } = mapSpeakers([seg("s1", "speaker_1", "Hello"), seg("s2", "speaker_0", "Hi")]);
    expect(speaker_map).toEqual({ speaker_1: "therapist", speaker_0: "parent" });
  });
});

describe("formatTime and toPromptLines", () => {
  it("formats seconds as mm:ss", () => {
    expect(formatTime(0)).toBe("00:00");
    expect(formatTime(83.4)).toBe("01:23");
    expect(formatTime(90.2)).toBe("01:30");
    expect(formatTime(600)).toBe("10:00");
  });

  it("renders prompt lines with id, times and upper-case speaker", () => {
    const lines = toPromptLines([
      { id: "s12", speaker: "parent", speaker_label: "speaker_1", start_sec: 83.4, end_sec: 90.2, text: "He stopped talking." },
    ]);
    expect(lines).toEqual(["[s12 | 01:23-01:30 | PARENT] He stopped talking."]);
  });
});
