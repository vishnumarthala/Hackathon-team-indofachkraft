import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCRIBE_URL, transcribeAudio } from "@/lib/elevenlabs/stt";

const input = { audio: Buffer.from("RIFFfake"), fileName: "rec.wav", mimeType: "audio/wav" };
const sample = {
  language_code: "eng",
  text: "Hello",
  words: [{ text: "Hello", start: 0, end: 0.5, type: "word", speaker_id: "speaker_0" }],
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "ct-stt-"));
  writeFileSync(path.join(dir, "scribe-response.json"), JSON.stringify(sample));
  vi.stubEnv("DEMO_FIXTURES_DIR", dir);
  vi.stubEnv("ELEVENLABS_API_KEY", "test-key");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

describe("transcribeAudio", () => {
  it("returns the fixture in DEMO_MODE without calling fetch", async () => {
    vi.stubEnv("DEMO_MODE", "true");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(transcribeAudio(input)).resolves.toEqual(sample);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends scribe_v2 with diarization, 2 speakers, word timestamps and the xi-api-key header", async () => {
    vi.stubEnv("DEMO_MODE", "false");
    const fetchMock = vi.fn(async () => Response.json(sample));
    vi.stubGlobal("fetch", fetchMock);

    await expect(transcribeAudio(input)).resolves.toEqual(sample);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(SCRIBE_URL);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "xi-api-key": "test-key" });
    const form = init.body as FormData;
    expect(form.get("model_id")).toBe("scribe_v2");
    expect(form.get("diarize")).toBe("true");
    expect(form.get("num_speakers")).toBe("2");
    expect(form.get("timestamps_granularity")).toBe("word");
    expect(form.get("language_code")).toBeNull();
    const file = form.get("file") as File;
    expect(file.name).toBe("rec.wav");
    expect(file.type).toBe("audio/wav");
    expect(Buffer.from(await file.arrayBuffer()).toString()).toBe("RIFFfake");
  });

  it("throws an error containing the HTTP status on a non-2xx response", async () => {
    vi.stubEnv("DEMO_MODE", "false");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("quota exceeded", { status: 429 })));
    const err = await transcribeAudio(input).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("429");
    expect((err as Error).message).not.toContain("test-key");
  });

  it("rejects a malformed response", async () => {
    vi.stubEnv("DEMO_MODE", "false");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ words: "nope" })));
    await expect(transcribeAudio(input)).rejects.toThrow("Scribe returned an unexpected response");
  });

  it("fails in DEMO_MODE when the fixture is missing", async () => {
    vi.stubEnv("DEMO_MODE", "true");
    rmSync(path.join(dir, "scribe-response.json"));
    await expect(transcribeAudio(input)).rejects.toThrow("Missing fixture scribe-response.json");
  });
});
