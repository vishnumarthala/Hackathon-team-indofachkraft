import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { loadFixture } from "@/lib/demo";
import { GeminiError, generateJson, type GeminiClient } from "@/lib/gemini";

const schema = z.object({ a: z.string() });
type Call = Parameters<GeminiClient["models"]["generateContent"]>[0];

function fakeClient(answers: Array<string | Error>) {
  const calls: Call[] = [];
  const client: GeminiClient = {
    models: {
      generateContent: async (request) => {
        calls.push(structuredClone(request));
        const next = answers.shift();
        if (next instanceof Error) throw next;
        return { text: next };
      },
    },
  };
  return { client, calls };
}

function apiError(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}

const input = { task: "sample", system: "sys", prompt: "prompt" };

beforeEach(() => vi.stubEnv("DEMO_FIXTURES_DIR", "tests/fixtures"));
afterEach(() => vi.unstubAllEnvs());

describe("loadFixture", () => {
  it("loads and validates a fixture from disk", () => {
    expect(loadFixture("gemini/sample.json", schema)).toEqual({ a: "from fixture" });
    expect(loadFixture("gemini/invalid.json")).toEqual({ a: 42 });
  });

  it("reports a missing fixture", () => {
    expect(() => loadFixture("gemini/nope.json")).toThrow("Missing fixture gemini/nope.json");
  });

  it("reports an invalid fixture", () => {
    expect(() => loadFixture("gemini/invalid.json", schema)).toThrow(/^Invalid fixture gemini\/invalid\.json: /);
  });
});

describe("generateJson in DEMO_MODE", () => {
  beforeEach(() => vi.stubEnv("DEMO_MODE", "true"));

  it("returns the task fixture without calling Gemini", async () => {
    const { client, calls } = fakeClient([]);
    await expect(generateJson({ ...input, schema, client })).resolves.toEqual({ a: "from fixture" });
    expect(calls).toHaveLength(0);
  });

  it("wraps missing and invalid fixtures in GeminiError", async () => {
    await expect(generateJson({ ...input, task: "does-not-exist", schema })).rejects.toThrow(GeminiError);
    await expect(generateJson({ ...input, task: "does-not-exist", schema })).rejects.toThrow("Missing fixture");
    await expect(generateJson({ ...input, task: "invalid", schema })).rejects.toThrow(/Invalid fixture/);
  });
});

describe("generateJson live", () => {
  beforeEach(() => {
    vi.stubEnv("DEMO_MODE", "false");
    vi.stubEnv("GEMINI_MODEL", "test-model");
  });

  it("sends the JSON schema, system prompt and temperature", async () => {
    const { client, calls } = fakeClient(['{"a":"x"}']);
    await expect(generateJson({ ...input, schema, client })).resolves.toEqual({ a: "x" });
    expect(calls[0]).toMatchObject({
      model: "test-model",
      contents: "prompt",
      config: { systemInstruction: "sys", responseMimeType: "application/json", temperature: 0.2 },
    });
    expect(calls[0].config.responseJsonSchema).toMatchObject({ type: "object" });
  });

  it("falls back to JSON mode when the API rejects the schema, without using the retry", async () => {
    const { client, calls } = fakeClient([apiError(400, "Invalid JSON Schema in request"), "not json", '{"a":"ok"}']);
    await expect(generateJson({ ...input, schema, client })).resolves.toEqual({ a: "ok" });
    expect(calls).toHaveLength(3);
    expect(calls[1].config.responseJsonSchema).toBeUndefined();
    expect(calls[2].config.responseJsonSchema).toBeUndefined();
    expect(calls[2].contents).toBe("prompt\n\nYour previous output was invalid: Output was not valid JSON. Return only valid JSON.");
  });

  it("retries once after non-JSON output and then succeeds", async () => {
    const { client, calls } = fakeClient(["oops", '{"a":"second"}']);
    await expect(generateJson({ ...input, schema, client })).resolves.toEqual({ a: "second" });
    expect(calls).toHaveLength(2);
    expect(calls[1].contents).toContain("Your previous output was invalid: Output was not valid JSON.");
  });

  it("describes Zod problems in the retry prompt", async () => {
    const { client, calls } = fakeClient(['{"a":1}', '{"a":"fine"}']);
    await generateJson({ ...input, schema, client });
    expect(calls[1].contents).toMatch(/Your previous output was invalid: a: .+\. Return only valid JSON\.$/);
  });

  it("throws GeminiError after two invalid answers", async () => {
    const { client, calls } = fakeClient(['{"a":1}', "still not json"]);
    const err = await generateJson({ ...input, schema, client }).catch((e) => e);
    expect(err).toBeInstanceOf(GeminiError);
    expect(err.message).toBe("Gemini returned invalid output: Output was not valid JSON");
    expect(calls).toHaveLength(2);
  });

  it("does not retry other API errors", async () => {
    const { client, calls } = fakeClient([apiError(500, "server error")]);
    await expect(generateJson({ ...input, schema, client })).rejects.toThrow("Gemini request failed: server error");
    const { client: c2, calls: calls2 } = fakeClient([apiError(400, "bad request")]);
    await expect(generateJson({ ...input, schema, client: c2 })).rejects.toThrow(GeminiError);
    expect(calls).toHaveLength(1);
    expect(calls2).toHaveLength(1);
  });
});
