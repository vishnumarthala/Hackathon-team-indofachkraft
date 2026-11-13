// Ticket 040 FR-2: the model step (server only). Live: Gemini through lib/gemini.ts with prompts/follow-up.md.
// DEMO_MODE: `<DEMO_FIXTURES_DIR>/gemini/follow-up.json` (canned answers picked by keywords of the question; every
// read is logged as `followup model call`, so a red-flag question visibly makes none). The answer is then resolved
// against the documents actually sent: unknown refs are dropped, quotes are verified, and an uncited "found" answer
// becomes the not-found answer.
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { isDemoMode, loadFixture } from "@/lib/demo";
import { GeminiError, generateJson } from "@/lib/gemini";
import { logger } from "@/lib/log";
import {
  answerSuggestsMedicineChange,
  fixedAnswer,
  MODEL_TIMEOUT_MS,
  RED_FLAG_ANSWER,
  type FollowupAnswer,
  type FollowupCitation,
} from "./constants";
import { toCitation, type FollowupContext } from "./context";

const log = logger("followup");

export const ModelAnswerSchema = z.object({
  found: z.boolean(),
  answer: z.string(),
  medical_advice: z.boolean(),
  citations: z.array(z.object({ ref: z.string(), quote: z.string() })),
});
export type ModelAnswer = z.infer<typeof ModelAnswerSchema>;

export type Generate = (input: { system: string; prompt: string; question: string }) => Promise<ModelAnswer>;

export const DEMO_FIXTURE = "gemini/follow-up.json";

const DemoFixtureSchema = z.object({
  answers: z.array(ModelAnswerSchema.extend({ match: z.array(z.string()).min(1) })),
  fallback: ModelAnswerSchema,
});

export function followupSystemPrompt(): string {
  return readFileSync(path.join(process.cwd(), "prompts", "follow-up.md"), "utf8");
}

export function buildFollowupPrompt(question: string, contextText: string): string {
  return [
    "Your child's shared documents (ids in square brackets; cite them exactly as written):",
    "",
    contextText || "(no shared documents)",
    "",
    `Parent's question: ${question}`,
  ].join("\n");
}

/** DEMO_MODE: the first canned answer whose keyword is in the question, else the fixture's fallback. */
export function pickDemoAnswer(question: string, fixture: z.infer<typeof DemoFixtureSchema>): ModelAnswer {
  const q = question.toLowerCase();
  const hit = fixture.answers.find((a) => a.match.some((m) => q.includes(m.toLowerCase())));
  if (!hit) return fixture.fallback;
  return { found: hit.found, answer: hit.answer, medical_advice: hit.medical_advice, citations: hit.citations };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new GeminiError(`Model did not answer within ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export const defaultGenerate: Generate = async ({ system, prompt, question }) => {
  if (isDemoMode()) {
    log.info("followup model call", { demo: true, fixture: DEMO_FIXTURE });
    try {
      return pickDemoAnswer(question, loadFixture(DEMO_FIXTURE, DemoFixtureSchema));
    } catch (err) {
      throw new GeminiError(err instanceof Error ? err.message : String(err));
    }
  }
  log.info("followup model call", { demo: false });
  return withTimeout(generateJson({ task: "follow-up", system, prompt, schema: ModelAnswerSchema }), MODEL_TIMEOUT_MS);
};

/** Pure: the model's answer, checked against the documents sent and the medicine rule. */
export function resolveModelAnswer(answer: ModelAnswer, context: FollowupContext): FollowupAnswer {
  const text = answer.answer.trim();
  if (text === RED_FLAG_ANSWER) return fixedAnswer("red_flag");
  if (answer.medical_advice || answerSuggestsMedicineChange(text)) return fixedAnswer("medicine");
  if (!answer.found || text === "") return fixedAnswer("not_found");
  const citations: FollowupCitation[] = [];
  const seen = new Set<string>();
  for (const c of answer.citations) {
    const ref = c.ref.trim().replace(/^\[|\]$/g, "").toUpperCase();
    const doc = context.citable.get(ref);
    if (!doc || seen.has(ref)) continue;
    seen.add(ref);
    citations.push(toCitation(doc, c.quote));
  }
  if (citations.length === 0) return fixedAnswer("not_found");
  return { found: true, answer: text, citations };
}
