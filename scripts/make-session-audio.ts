// Synthesises the role-play session (demo/fixtures/roleplay-segments.json) as demo/audio/session-1.mp3
// with ElevenLabs text-to-speech. Each turn starts at its fixture start_sec, so seeded evidence
// timestamps play the right moment. Synthetic AI voices only.
//
// Usage: npx tsx scripts/make-session-audio.ts [--therapist-voice <id>] [--parent-voice <id>] [--out <file>]
// Needs ELEVENLABS_API_KEY (or ELEVEL_LABS_KEY) in .env.local, plus ffmpeg/ffprobe on PATH.
// Clips are cached in .tmp/session-audio/, so re-running does not spend credits again.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd(), false, { info() {}, error: console.error });

type Segment = { id: string; speaker: string; speaker_label: string; start_sec: number; end_sec: number; text: string };
type Voice = { voice_id: string; name: string; category?: string; labels?: Record<string, string> };

const API = "https://api.elevenlabs.io/v1";
const MODEL = "eleven_multilingual_v2";
const MAX_TEMPO = 1.35;
const GAP_AFTER_SEC = 0.3;
const CACHE_DIR = path.join(".tmp", "session-audio");
const SEGMENTS_FILE = path.join("demo", "fixtures", "roleplay-segments.json");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function apiKey(): string {
  const key = process.env.ELEVENLABS_API_KEY || process.env.ELEVEL_LABS_KEY;
  if (!key) {
    console.error("No ElevenLabs key: set ELEVENLABS_API_KEY (or ELEVEL_LABS_KEY) in .env.local");
    process.exit(1);
  }
  return key;
}

async function api(pathname: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(`${API}${pathname}`, {
    ...init,
    headers: { "xi-api-key": apiKey(), ...(init.headers ?? {}) },
  });
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 500);
    throw new Error(`ElevenLabs ${pathname.split("?")[0]} failed (HTTP ${res.status}): ${body}`);
  }
  return res;
}

const isFemale = (v: Voice) => (v.labels?.gender ?? "").toLowerCase() === "female";
const isIndian = (v: Voice) => /indian|hindi|telugu|tamil/i.test(`${v.labels?.accent ?? ""} ${v.labels?.language ?? ""}`);
const describe = (v: Voice) => `${v.name} (${v.voice_id}${v.labels?.accent ? `, ${v.labels.accent}` : ""})`;

async function pickVoices(): Promise<{ therapist: Voice; parent: Voice }> {
  const { voices } = (await (await api("/voices")).json()) as { voices: Voice[] };
  const byId = (id: string) => {
    const v = voices.find((x) => x.voice_id === id);
    if (!v) throw new Error(`Voice ${id} is not in this account's voice list`);
    return v;
  };
  const tArg = arg("therapist-voice");
  const pArg = arg("parent-voice");
  const female = voices.filter(isFemale);
  const ranked = [...female.filter(isIndian), ...female.filter((v) => !isIndian(v)), ...voices.filter((v) => !isFemale(v))];
  const therapist = tArg ? byId(tArg) : ranked[0];
  const parent = pArg ? byId(pArg) : ranked.find((v) => v.voice_id !== therapist?.voice_id);
  if (!therapist || !parent) throw new Error("Need at least two voices in the ElevenLabs account");
  return { therapist, parent };
}

async function synthesize(seg: Segment, voice: Voice, prev?: Segment, next?: Segment): Promise<{ file: string; chars: number }> {
  const file = path.join(CACHE_DIR, `${voice.voice_id}-${seg.id}.mp3`);
  if (existsSync(file)) return { file, chars: 0 };
  const res = await api(`/text-to-speech/${voice.voice_id}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify({
      text: seg.text,
      model_id: MODEL,
      previous_text: prev?.text,
      next_text: next?.text,
      voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: 1.1 },
    }),
  });
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  return { file, chars: seg.text.length };
}

function duration(file: string): number {
  const out = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
  return Number(out.toString().trim());
}

// atempo accepts 0.5..2.0 per filter; we never exceed MAX_TEMPO, so one filter is enough.
function tempoFilter(tempo: number): string {
  return tempo > 1.0001 ? `atempo=${tempo.toFixed(4)},` : "";
}

async function main() {
  const out = arg("out") ?? path.join("demo", "audio", "session-1.mp3");
  const segments = JSON.parse(readFileSync(SEGMENTS_FILE, "utf8")) as Segment[];
  mkdirSync(CACHE_DIR, { recursive: true });

  const { therapist, parent } = await pickVoices();
  console.log(`therapist voice: ${describe(therapist)}`);
  console.log(`parent voice:    ${describe(parent)}`);
  const voiceFor = (s: Segment) => (s.speaker === "therapist" ? therapist : parent);

  let charsSent = 0;
  const clips: Array<{ seg: Segment; file: string; dur: number }> = [];
  for (const [i, seg] of segments.entries()) {
    const { file, chars } = await synthesize(seg, voiceFor(seg), segments[i - 1], segments[i + 1]);
    charsSent += chars;
    clips.push({ seg, file, dur: duration(file) });
    process.stdout.write(`\rsynthesised ${i + 1}/${segments.length}`);
  }
  process.stdout.write("\n");

  const last = segments[segments.length - 1];
  const total = last.end_sec + 2;
  const warnings: string[] = [];
  const rows: string[] = [];
  const plan = clips.map(({ seg, file, dur }, i) => {
    const nextStart = segments[i + 1]?.start_sec ?? total;
    const budget = nextStart - seg.start_sec - GAP_AFTER_SEC;
    let tempo = dur > budget ? dur / budget : 1;
    if (tempo > MAX_TEMPO) {
      warnings.push(`${seg.id}: needs tempo ${tempo.toFixed(2)}, capped at ${MAX_TEMPO}; overlaps the next turn`);
      tempo = MAX_TEMPO;
    }
    const end = seg.start_sec + dur / tempo;
    rows.push(
      [seg.id.padEnd(4), seg.speaker.padEnd(9), seg.start_sec.toFixed(2).padStart(7), dur.toFixed(2).padStart(6),
        tempo.toFixed(2).padStart(5), end.toFixed(2).padStart(7), (nextStart - end).toFixed(2).padStart(6)].join(" "),
    );
    return { seg, file, tempo };
  });

  // Mix: every clip delayed to its start, plus very quiet room tone so it is not studio-clean.
  const inputs = plan.flatMap((p) => ["-i", p.file]);
  const chains = plan.map((p, i) => `[${i}:a]${tempoFilter(p.tempo)}adelay=${Math.round(p.seg.start_sec * 1000)}:all=1[c${i}]`);
  const noise = `anoisesrc=color=pink:amplitude=0.001:sample_rate=44100:duration=${total.toFixed(2)}[room]`;
  const mixInputs = plan.map((_, i) => `[c${i}]`).join("") + "[room]";
  const filter = [...chains, noise, `${mixInputs}amix=inputs=${plan.length + 1}:normalize=0:duration=longest[out]`].join(";");
  mkdirSync(path.dirname(out), { recursive: true });
  execFileSync("ffmpeg", [
    "-y", "-loglevel", "error", ...inputs, "-filter_complex", filter, "-map", "[out]",
    "-t", total.toFixed(2), "-ac", "1", "-ar", "44100", "-c:a", "libmp3lame", "-b:a", "64k", out,
  ]);

  console.log("\nid   speaker     start   clip tempo     end  silence");
  console.log(rows.join("\n"));
  if (warnings.length) console.log(`\nwarnings:\n${warnings.join("\n")}`);
  console.log(`\nmodel ${MODEL}; characters sent this run: ${charsSent} (cached clips cost nothing)`);
  console.log(`wrote ${out}: ${duration(out).toFixed(1)} s, ${(readFileSync(out).length / 1e6).toFixed(2)} MB`);
}

main().catch((err) => {
  console.error(`make-session-audio failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
