// Builds demo/fixtures/scribe-response.json (Scribe v2 shape) from demo/fixtures/roleplay-segments.json.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { SegmentSchema, type Segment } from "../lib/types";

export type ScribeWord = {
  text: string;
  type: "word" | "spacing";
  start: number;
  end: number;
  speaker_id: string;
};

export type ScribeResponse = {
  language_code: string;
  language_probability: number;
  text: string;
  words: ScribeWord[];
};

export const SEGMENTS_FILE = "demo/fixtures/roleplay-segments.json";
export const SCRIBE_FILE = "demo/fixtures/scribe-response.json";

const round2 = (n: number) => Math.round(n * 100) / 100;

export function buildScribeResponse(segments: Segment[]): ScribeResponse {
  const words: ScribeWord[] = [];
  for (const segment of segments) {
    const tokens = segment.text.split(" ");
    const step = (segment.end_sec - segment.start_sec) / tokens.length;
    const times = tokens.map((_, i) => ({
      start: i === 0 ? segment.start_sec : round2(segment.start_sec + i * step),
      end: i === tokens.length - 1 ? segment.end_sec : round2(segment.start_sec + (i + 1) * step),
    }));
    tokens.forEach((text, i) => {
      if (i > 0) {
        words.push({
          text: " ",
          type: "spacing",
          start: times[i - 1].end,
          end: times[i].start,
          speaker_id: segment.speaker_label,
        });
      }
      words.push({ text, type: "word", start: times[i].start, end: times[i].end, speaker_id: segment.speaker_label });
    });
  }
  return {
    language_code: "eng",
    language_probability: 0.9,
    text: segments.map((s) => s.text).join(" "),
    words,
  };
}

// One word entry per line keeps the file small and diffable; output is byte-for-byte deterministic.
export function serializeScribeResponse(response: ScribeResponse): string {
  const head = [
    `  "language_code": ${JSON.stringify(response.language_code)}`,
    `  "language_probability": ${JSON.stringify(response.language_probability)}`,
    `  "text": ${JSON.stringify(response.text)}`,
  ];
  const words = response.words.map((w) => `    ${JSON.stringify(w)}`).join(",\n");
  return `{\n${head.join(",\n")},\n  "words": [\n${words}\n  ]\n}\n`;
}

export function readRoleplaySegments(root = process.cwd()): Segment[] {
  const raw = JSON.parse(readFileSync(path.join(root, SEGMENTS_FILE), "utf8"));
  return z.array(SegmentSchema).parse(raw);
}

function main() {
  const out = serializeScribeResponse(buildScribeResponse(readRoleplaySegments()));
  writeFileSync(path.join(process.cwd(), SCRIBE_FILE), out);
  console.log(`wrote ${SCRIBE_FILE}`);
}

if (process.argv[1] && /make-scribe-fixture\.ts$/.test(process.argv[1])) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
