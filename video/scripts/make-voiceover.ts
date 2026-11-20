// Generates the jury-video narration with ElevenLabs text-to-speech, one clip per scene, plus an
// optional instrumental music bed and a short excerpt of the synthetic intake call.
// Writes video/public/voice/*.mp3, video/public/music/bed.mp3, video/public/intake-snippet.mp3
// and video/src/voiceover.json (durations drive scene lengths in the composition).
//
// Usage (from video/): npm run voice -- [--voice <voice_id>] [--no-music] [--engine say]
// Needs ELEVENLABS_API_KEY (or ELEVEL_LABS_KEY) in the repo's .env.local / env, and ffmpeg/ffprobe.
// If the key is missing or rejected, it falls back to the macOS `say` voice "Tara" (en_IN, placeholder
// quality, no music) so the video still renders; fix the key and re-run to get the ElevenLabs voice.
// Clips are cached in <repo>/.tmp/video-voice/ by text + voice, so re-runs only pay for changed lines.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadEnvConfig } from "@next/env";
import { SCRIPT } from "../src/script";

const VIDEO_DIR = path.resolve(__dirname, "..");
const REPO_DIR = path.resolve(VIDEO_DIR, "..");
loadEnvConfig(REPO_DIR, false, { info() {}, error: console.error });

const API = "https://api.elevenlabs.io/v1";
const MODEL = "eleven_multilingual_v2";
const CACHE_DIR = path.join(REPO_DIR, ".tmp", "video-voice");
const VOICE_DIR = path.join(VIDEO_DIR, "public", "voice");
const MUSIC_DIR = path.join(VIDEO_DIR, "public", "music");
const MANIFEST = path.join(VIDEO_DIR, "src", "voiceover.json");
const INTAKE_SRC = path.join(REPO_DIR, "public", "landing", "sample-intake-call.mp3");
// "What worries you most about Ravi right now?" ... "he does not turn when we call his name."
const INTAKE_FROM = 23.6;
const INTAKE_TO = 32.7;
const MUSIC_PROMPT =
  "Warm, hopeful, minimal instrumental background for a healthcare startup pitch video. Soft felt piano, gentle plucked strings, light ambient pads, slow steady pulse around 90 BPM, no drums, no vocals, unobtrusive and calm, suitable under narration.";

type Voice = { voice_id: string; name: string; labels?: Record<string, string> };

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const SAY_VOICE = "Tara";
const SAY_RATE = "166";

function apiKey(): string {
  const key = (process.env.ELEVENLABS_API_KEY || process.env.ELEVEL_LABS_KEY || "").trim();
  if (!key) throw new Error("No ElevenLabs key: set ELEVENLABS_API_KEY (or ELEVEL_LABS_KEY) in .env.local or the environment");
  return key;
}

async function api(pathname: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(`${API}${pathname}`, { ...init, headers: { "xi-api-key": apiKey(), ...(init.headers ?? {}) } });
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 400);
    throw new Error(`ElevenLabs ${pathname.split("?")[0]} failed (HTTP ${res.status}): ${body}`);
  }
  return res;
}

/** Loudness-normalise speech to about -16 LUFS so the video plays at a typical web volume. */
const normalize = (from: string, to: string, extra: string[] = []) =>
  execFileSync("ffmpeg", ["-y", "-v", "error", "-i", from, ...extra, "-af", "loudnorm=I=-16:TP=-1.5:LRA=11", "-ar", "44100", "-b:a", "160k", to]);

const duration = (file: string) =>
  Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).toString().trim());

async function pickVoice(): Promise<Voice> {
  const { voices } = (await (await api("/voices")).json()) as { voices: Voice[] };
  const wanted = arg("voice");
  if (wanted) {
    const v = voices.find((x) => x.voice_id === wanted);
    if (!v) throw new Error(`Voice ${wanted} is not in this account's voice list`);
    return v;
  }
  const female = voices.filter((v) => (v.labels?.gender ?? "").toLowerCase() === "female");
  const indian = female.filter((v) => /indian|hindi|telugu/i.test(`${v.labels?.accent ?? ""} ${v.labels?.language ?? ""}`));
  const envEn = voices.find((v) => v.voice_id === process.env.ELEVENLABS_VOICE_ID_EN);
  const pick = indian[0] ?? envEn ?? female[0] ?? voices[0];
  if (!pick) throw new Error("No voices in this ElevenLabs account");
  return pick;
}

async function tts(voice: Voice, text: string, prev?: string, next?: string): Promise<string> {
  const hash = createHash("sha1").update(`${voice.voice_id}|${MODEL}|${prev ?? ""}|${text}|${next ?? ""}`).digest("hex").slice(0, 16);
  const file = path.join(CACHE_DIR, `${hash}.mp3`);
  if (existsSync(file)) return file;
  const res = await api(`/text-to-speech/${voice.voice_id}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify({
      text,
      model_id: MODEL,
      previous_text: prev,
      next_text: next,
      voice_settings: { stability: 0.55, similarity_boost: 0.8, style: 0.15, use_speaker_boost: true, speed: 1.0 },
    }),
  });
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  return file;
}

function saySpeech(text: string): string {
  const hash = createHash("sha1").update(`say|${SAY_VOICE}|${SAY_RATE}|${text}`).digest("hex").slice(0, 16);
  const file = path.join(CACHE_DIR, `say-${hash}.mp3`);
  if (existsSync(file)) return file;
  const aiff = file.replace(/\.mp3$/, ".aiff");
  // The neural `say` voices occasionally render a line far too slowly; retry those.
  for (let attempt = 0; attempt < 6; attempt++) {
    execFileSync("say", ["-v", SAY_VOICE, "-r", SAY_RATE, "-o", aiff, text]);
    if (text.length / duration(aiff) >= 14) break;
  }
  execFileSync("ffmpeg", ["-y", "-v", "error", "-i", aiff, "-ar", "44100", "-ac", "1", "-b:a", "128k", file]);
  return file;
}

async function music(lengthMs: number): Promise<string | null> {
  const file = path.join(CACHE_DIR, `music-${lengthMs}.mp3`);
  if (!existsSync(file)) {
    try {
      const res = await api("/music?output_format=mp3_44100_128", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: MUSIC_PROMPT, music_length_ms: lengthMs, force_instrumental: true }),
      });
      writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    } catch (err) {
      console.warn(`Music skipped: ${(err as Error).message}`);
      return null;
    }
  }
  return file;
}

async function main() {
  for (const dir of [CACHE_DIR, VOICE_DIR, MUSIC_DIR]) mkdirSync(dir, { recursive: true });
  let voice: Voice | null = null;
  if (arg("engine") !== "say") {
    try {
      voice = await pickVoice();
      console.log(`Narrator: ElevenLabs ${voice.name} (${voice.voice_id}${voice.labels?.accent ? `, ${voice.labels.accent}` : ""})`);
    } catch (err) {
      console.warn(`ElevenLabs unavailable (${(err as Error).message.slice(0, 160)})`);
    }
  }
  if (!voice) console.warn(`FALLBACK: narrating with macOS say -v ${SAY_VOICE}. Fix the ElevenLabs key and re-run for the real voice.`);

  const scenes: { id: string; file: string; duration: number }[] = [];
  for (const [i, line] of SCRIPT.entries()) {
    const cached = voice ? await tts(voice, line.voice, SCRIPT[i - 1]?.voice, SCRIPT[i + 1]?.voice) : saySpeech(line.voice);
    const out = path.join(VOICE_DIR, `${line.id}.mp3`);
    normalize(cached, out);
    const d = duration(out);
    scenes.push({ id: line.id, file: `voice/${line.id}.mp3`, duration: Number(d.toFixed(3)) });
    console.log(`  ${line.id.padEnd(10)} ${d.toFixed(1)}s`);
  }

  const intakeOut = path.join(VIDEO_DIR, "public", "intake-snippet.mp3");
  const fadeOut = (INTAKE_TO - INTAKE_FROM - 0.3).toFixed(2);
  execFileSync("ffmpeg", ["-y", "-v", "error", "-ss", String(INTAKE_FROM), "-to", String(INTAKE_TO), "-i", INTAKE_SRC,
    "-af", `loudnorm=I=-16:TP=-1.5:LRA=11,afade=t=in:d=0.15,afade=t=out:st=${fadeOut}:d=0.3`, "-ar", "44100", intakeOut]);
  const intake = { file: "intake-snippet.mp3", duration: Number(duration(intakeOut).toFixed(3)) };

  const speech = scenes.reduce((s, x) => s + x.duration, 0) + intake.duration;
  const total = Math.ceil(speech + scenes.length * 1.2 + 4);
  let musicFile: string | null = null;
  if (voice && !process.argv.includes("--no-music")) {
    const m = await music(total * 1000);
    if (m) {
      copyFileSync(m, path.join(MUSIC_DIR, "bed.mp3"));
      musicFile = "music/bed.mp3";
    }
  }

  writeFileSync(MANIFEST, JSON.stringify({ engine: voice ? "elevenlabs" : "say", voice: voice?.name ?? SAY_VOICE, scenes, intake, music: musicFile }, null, 2) + "\n");
  console.log(`Speech ${speech.toFixed(1)}s (incl. intake ${intake.duration.toFixed(1)}s), music: ${musicFile ?? "none"}`);
  console.log(`Wrote ${path.relative(REPO_DIR, MANIFEST)}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
