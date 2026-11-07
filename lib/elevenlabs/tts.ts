// 015 FR-3: ElevenLabs text-to-speech. Server only: the API key never leaves this module.
import { env } from "@/lib/env";
import type { Language } from "@/lib/types";

export const TTS_URL = "https://api.elevenlabs.io/v1/text-to-speech";
export const TTS_MODEL = "eleven_v3"; // supports Telugu and Hindi (D-1)

export class NoVoiceError extends Error {
  constructor(language: string) {
    super(`No voice configured for ${language}`);
    this.name = "NoVoiceError";
  }
}

export function voiceIdFor(language: Language): string {
  const voice =
    language === "te" ? env.ELEVENLABS_VOICE_ID_TE : language === "hi" ? env.ELEVENLABS_VOICE_ID_HI : env.ELEVENLABS_VOICE_ID_EN;
  if (!voice) throw new NoVoiceError(language);
  return voice;
}

export async function synthesize({ text, language }: { text: string; language: Language }): Promise<Buffer> {
  const voiceId = voiceIdFor(language);
  const res = await fetch(`${TTS_URL}/${encodeURIComponent(voiceId)}`, {
    method: "POST",
    headers: { "xi-api-key": env.ELEVENLABS_API_KEY, "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify({ text, model_id: TTS_MODEL }),
  });
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(`TTS request failed (HTTP ${res.status})${body ? `: ${body}` : ""}`);
  }
  const audio = Buffer.from(await res.arrayBuffer());
  if (audio.length === 0) throw new Error("TTS returned no audio");
  return audio;
}
