import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { loadFixture } from "@/lib/demo";
import { env } from "@/lib/env";

const GEMINI_TIMEOUT_MS = 60_000;

export class GeminiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeminiError";
  }
}

type GenerateRequest = {
  model: string;
  contents: string;
  config: {
    systemInstruction: string;
    responseMimeType: "application/json";
    responseJsonSchema?: unknown;
    temperature: number;
    httpOptions?: { timeout?: number };
  };
};

export type GeminiClient = {
  models: { generateContent(request: GenerateRequest): Promise<{ text?: string | undefined }> };
};

export type GenerateJsonInput<T> = {
  task: string;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  client?: GeminiClient;
};

function defaultClient(): GeminiClient {
  return new GoogleGenAI({ apiKey: env.GEMINI_API_KEY }) as unknown as GeminiClient;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isSchemaRejection(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  return status === 400 && /schema/i.test(messageOf(err));
}

function problemOf<T>(text: string | undefined, schema: z.ZodType<T>): { data: T } | { problem: string } {
  let json: unknown;
  try {
    json = JSON.parse(text ?? "");
  } catch {
    return { problem: "Output was not valid JSON" };
  }
  const result = schema.safeParse(json);
  if (result.success) return { data: result.data };
  const problem = result.error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  return { problem };
}

export async function generateJson<T>({ task, system, prompt, schema, client }: GenerateJsonInput<T>): Promise<T> {
  if (env.DEMO_MODE) {
    try {
      return loadFixture(`gemini/${task}.json`, schema);
    } catch (err) {
      throw new GeminiError(messageOf(err));
    }
  }

  const gemini = client ?? defaultClient();
  const model = env.GEMINI_MODEL;
  const jsonSchema = z.toJSONSchema(schema, { unrepresentable: "any" });
  let useSchema = true;

  async function call(contents: string): Promise<string | undefined> {
    const config = {
      systemInstruction: system,
      responseMimeType: "application/json" as const,
      temperature: 0.2,
      // Fail fast (route answers 502) instead of hanging while the model is overloaded.
      httpOptions: { timeout: GEMINI_TIMEOUT_MS },
      ...(useSchema ? { responseJsonSchema: jsonSchema } : {}),
    };
    try {
      const response = await gemini.models.generateContent({ model, contents, config });
      return response.text;
    } catch (err) {
      if (useSchema && isSchemaRejection(err)) {
        useSchema = false;
        return call(contents);
      }
      throw new GeminiError(`Gemini request failed: ${messageOf(err)}`);
    }
  }

  const first = problemOf(await call(prompt), schema);
  if ("data" in first) return first.data;

  const retryPrompt = `${prompt}\n\nYour previous output was invalid: ${first.problem}. Return only valid JSON.`;
  const second = problemOf(await call(retryPrompt), schema);
  if ("data" in second) return second.data;
  throw new GeminiError(`Gemini returned invalid output: ${second.problem}`);
}
