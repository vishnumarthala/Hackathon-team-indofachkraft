import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NoVoiceError, TTS_MODEL, TTS_URL, synthesize, voiceIdFor } from "@/lib/elevenlabs/tts";

const KEY = "sk_test_tts_key";
const mp3 = new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3]);

beforeEach(() => {
  vi.stubEnv("ELEVENLABS_API_KEY", KEY);
  vi.stubEnv("ELEVENLABS_VOICE_ID_EN", "voice_en");
  vi.stubEnv("ELEVENLABS_VOICE_ID_HI", "voice_hi");
  vi.stubEnv("ELEVENLABS_VOICE_ID_TE", "voice_te");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("voiceIdFor", () => {
  it("picks the voice per language", () => {
    expect(voiceIdFor("en")).toBe("voice_en");
    expect(voiceIdFor("hi")).toBe("voice_hi");
    expect(voiceIdFor("te")).toBe("voice_te");
  });

  it("throws `No voice configured for te` when ELEVENLABS_VOICE_ID_TE is empty", () => {
    vi.stubEnv("ELEVENLABS_VOICE_ID_TE", "");
    expect(() => voiceIdFor("te")).toThrow(NoVoiceError);
    expect(() => voiceIdFor("te")).toThrow("No voice configured for te");
    vi.stubEnv("ELEVENLABS_VOICE_ID_HI", "");
    expect(() => voiceIdFor("hi")).toThrow("No voice configured for hi");
  });
});

describe("synthesize", () => {
  it("POSTs text + eleven_v3 to /v1/text-to-speech/<voice> with xi-api-key and returns the mp3 Buffer", async () => {
    const fetchMock = vi.fn(async () => new Response(mp3, { status: 200, headers: { "Content-Type": "audio/mpeg" } }));
    vi.stubGlobal("fetch", fetchMock);
    const audio = await synthesize({ text: "నమస్కారం", language: "te" });
    expect(Buffer.isBuffer(audio)).toBe(true);
    expect([...audio]).toEqual([...mp3]);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.elevenlabs.io/v1/text-to-speech/voice_te");
    expect(url.startsWith(TTS_URL)).toBe(true);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["xi-api-key"]).toBe(KEY);
    expect(JSON.parse(init.body as string)).toEqual({ text: "నమస్కారం", model_id: "eleven_v3" });
    expect(TTS_MODEL).toBe("eleven_v3");
  });

  it("uses the Hindi and English voices", async () => {
    const fetchMock = vi.fn(async () => new Response(mp3));
    vi.stubGlobal("fetch", fetchMock);
    await synthesize({ text: "a", language: "hi" });
    await synthesize({ text: "b", language: "en" });
    expect(fetchMock.mock.calls.map((c) => (c as unknown as [string])[0])).toEqual([
      `${TTS_URL}/voice_hi`,
      `${TTS_URL}/voice_en`,
    ]);
  });

  it("missing voice throws before any request", async () => {
    vi.stubEnv("ELEVENLABS_VOICE_ID_TE", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(synthesize({ text: "x", language: "te" })).rejects.toThrow("No voice configured for te");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws on HTTP errors and empty audio, without leaking the key", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("quota exceeded", { status: 429 })));
    const err = await synthesize({ text: "x", language: "en" }).catch((e: Error) => e);
    expect(String(err)).toContain("HTTP 429");
    expect(String(err)).not.toContain(KEY);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(0))));
    await expect(synthesize({ text: "x", language: "en" })).rejects.toThrow("TTS returned no audio");
  });
});
