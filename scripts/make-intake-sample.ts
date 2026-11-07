// Generates the landing page's "Listen to a sample call": the first turns of the synthetic intake call
// (demo/fixtures/elevenlabs-post-call.json) spoken with ElevenLabs text-to-speech, naturally paced.
// Writes public/landing/sample-intake-call.mp3 and components/landing/sampleCall.ts (turns + start times).
//
// Usage: npx tsx scripts/make-intake-sample.ts [--agent-voice <id>] [--parent-voice <id>] [--turns 18]
// Needs ELEVENLABS_API_KEY in .env.local and ffmpeg/ffprobe. Clips are cached in .tmp/intake-sample/.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd(), false, { info() {}, error: console.error });

type Turn = { role: "agent" | "user"; message: string | null; time_in_call_secs: number };
type Voice = { voice_id: string; name: string; labels?: Record<string, string> };

const API = "https://api.elevenlabs.io/v1";
const MODEL = "eleven_multilingual_v2";
const PAUSE_SEC = 0.7;
const CACHE_DIR = path.join(".tmp", "intake-sample");
const OUT_AUDIO = path.join("public", "landing", "sample-intake-call.mp3");
const OUT_TS = path.join("components", "landing", "sampleCall.ts");

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

function key(): string {
  const k = process.env.ELEVENLABS_API_KEY;
  if (!k) {
    console.error("Set ELEVENLABS_API_KEY in .env.local");
    process.exit(1);
  }
  return k;
}

async function api(pathname: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(`${API}${pathname}`, { ...init, headers: { "xi-api-key": key(), ...(init.headers ?? {}) } });
  if (!res.ok) throw new Error(`ElevenLabs ${pathname.split("?")[0]} failed (HTTP ${res.status}): ${(await res.text()).slice(0, 300)}`);
  return res;
}

async function pickVoices(): Promise<{ agent: Voice; parent: Voice }> {
  const { voices } = (await (await api("/voices")).json()) as { voices: Voice[] };
  const byId = (id: string) => voices.find((v) => v.voice_id === id) ?? { voice_id: id, name: id };
  const female = voices.filter((v) => v.labels?.gender === "female");
  // Session audio uses Sarah (therapist) and Laura (parent); prefer other voices for the intake call.
  const fresh = female.filter((v) => !/^(Sarah|Laura)\b/.test(v.name));
  const pool = [...fresh, ...female];
  const agent = arg("agent-voice") ? byId(arg("agent-voice")!) : pool[0];
  const parent = arg("parent-voice") ? byId(arg("parent-voice")!) : pool.find((v) => v.voice_id !== agent?.voice_id);
  if (!agent || !parent) throw new Error("Need two voices in the ElevenLabs account");
  return { agent, parent };
}

const duration = (file: string) =>
  Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).toString().trim());

async function main() {
  const maxTurns = Number(arg("turns") ?? 18);
  const all = (JSON.parse(readFileSync("demo/fixtures/elevenlabs-post-call.json", "utf8")) as { data: { transcript: Turn[] } })
    .data.transcript;
  const turns = all.slice(0, maxTurns).filter((t): t is Turn & { message: string } => Boolean(t.message));
  mkdirSync(CACHE_DIR, { recursive: true });

  const { agent, parent } = await pickVoices();
  console.log(`agent voice:  ${agent.name} (${agent.voice_id})`);
  console.log(`parent voice: ${parent.name} (${parent.voice_id})`);

  let chars = 0;
  const clips: Array<{ role: Turn["role"]; text: string; file: string; dur: number }> = [];
  for (const [i, t] of turns.entries()) {
    const voice = t.role === "agent" ? agent : parent;
    const file = path.join(CACHE_DIR, `${voice.voice_id}-${i}.mp3`);
    if (!existsSync(file)) {
      const res = await api(`/text-to-speech/${voice.voice_id}?output_format=mp3_44100_128`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "audio/mpeg" },
        body: JSON.stringify({
          text: t.message,
          model_id: MODEL,
          previous_text: turns[i - 1]?.message,
          next_text: turns[i + 1]?.message,
          voice_settings: { stability: 0.55, similarity_boost: 0.75, speed: t.role === "agent" ? 1.0 : 1.05 },
        }),
      });
      writeFileSync(file, Buffer.from(await res.arrayBuffer()));
      chars += t.message.length;
    }
    clips.push({ role: t.role, text: t.message, file, dur: duration(file) });
  }

  // Sequential timeline with short pauses, like a real call.
  let cursor = 0.4;
  const timeline = clips.map((c) => {
    const start = cursor;
    cursor += c.dur + PAUSE_SEC;
    return { ...c, start: Math.round(start * 100) / 100, end: Math.round((start + c.dur) * 100) / 100 };
  });
  const total = cursor + 0.5;

  const inputs = timeline.flatMap((t) => ["-i", t.file]);
  const chains = timeline.map((t, i) => `[${i}:a]adelay=${Math.round(t.start * 1000)}:all=1[c${i}]`);
  const filter = [...chains, `${timeline.map((_, i) => `[c${i}]`).join("")}amix=inputs=${timeline.length}:normalize=0:duration=longest[out]`].join(";");
  mkdirSync(path.dirname(OUT_AUDIO), { recursive: true });
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...inputs, "-filter_complex", filter, "-map", "[out]",
    "-t", total.toFixed(2), "-ac", "1", "-ar", "44100", "-c:a", "libmp3lame", "-b:a", "64k", OUT_AUDIO]);

  const ts = `// Generated by scripts/make-intake-sample.ts from demo/fixtures/elevenlabs-post-call.json. Do not edit by hand.
// Synthetic role-play: AI intake assistant and a parent (Lakshmi) talking about Ravi. AI voices only.
export type SampleTurn = { role: "agent" | "parent"; text: string; start: number; end: number };

export const SAMPLE_CALL_SRC = "/landing/sample-intake-call.mp3";
export const SAMPLE_CALL_DURATION = ${total.toFixed(2)};

export const SAMPLE_CALL: SampleTurn[] = ${JSON.stringify(
    timeline.map((t) => ({ role: t.role === "agent" ? "agent" : "parent", text: t.text, start: t.start, end: t.end })),
    null,
    2,
  )};
`;
  writeFileSync(OUT_TS, ts);
  console.log(`characters sent this run: ${chars}; ${timeline.length} turns; ${total.toFixed(1)} s`);
  console.log(`wrote ${OUT_AUDIO} (${(readFileSync(OUT_AUDIO).length / 1e6).toFixed(2)} MB) and ${OUT_TS}`);
}

main().catch((err) => {
  console.error(`make-intake-sample failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
