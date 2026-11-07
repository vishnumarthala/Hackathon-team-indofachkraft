import { z } from "zod";
import { isDemoMode, loadFixture } from "@/lib/demo";
import { env } from "@/lib/env";

export const SCRIBE_URL = "https://api.elevenlabs.io/v1/speech-to-text";

const ScribeWordSchema = z.object({
  text: z.string(),
  start: z.number().nullish(),
  end: z.number().nullish(),
  type: z.enum(["word", "spacing", "audio_event"]),
  speaker_id: z.string().nullish(),
});

export const ScribeResponseSchema = z.object({
  language_code: z.string().nullish(),
  text: z.string().default(""),
  words: z.array(ScribeWordSchema).default([]),
});
export type ScribeResponse = z.infer<typeof ScribeResponseSchema>;

export type TranscribeInput = { audio: Buffer; fileName: string; mimeType: string };

// Server only: the API key never leaves this module.
export async function transcribeAudio({ audio, fileName, mimeType }: TranscribeInput): Promise<ScribeResponse> {
  if (isDemoMode()) return loadFixture("scribe-response.json", ScribeResponseSchema);

  const form = new FormData();
  form.append("model_id", "scribe_v2");
  form.append("diarize", "true");
  form.append("num_speakers", "2");
  form.append("timestamps_granularity", "word");
  form.append("file", new Blob([new Uint8Array(audio)], { type: mimeType }), fileName);

  const res = await fetch(SCRIBE_URL, {
    method: "POST",
    headers: { "xi-api-key": env.ELEVENLABS_API_KEY },
    body: form,
  });
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(`Scribe request failed (HTTP ${res.status})${body ? `: ${body}` : ""}`);
  }
  const parsed = ScribeResponseSchema.safeParse(await res.json().catch(() => null));
  if (!parsed.success) throw new Error("Scribe returned an unexpected response");
  return parsed.data;
}
