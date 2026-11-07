import { z } from "zod";
import { resolveAnswer, type AskResult } from "@/lib/ask/citations";
import { askSystemPrompt, buildAskContext, buildAskPrompt, loadAskCase } from "@/lib/ask/context";
import { completeQuestion, releaseQuestion, reserveQuestion } from "@/lib/ask/questions";
import { audit } from "@/lib/audit";
import { isUuid } from "@/lib/cases/validation";
import { GeminiError, generateJson } from "@/lib/gemini";
import { fail, fieldErrors, ok, parseJson } from "@/lib/http";
import { getReferralByToken } from "@/lib/queries/referrals";
import { AskAnswerSchema } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const BodySchema = z.object({ share_token: z.string().max(200), question: z.unknown() });

const QuestionSchema = z.object({
  question: z
    .string({ error: "Question must be text" })
    .trim()
    .min(3, "Question must be at least 3 characters")
    .max(500, "Question must be at most 500 characters"),
});

const notFound = () => fail(404, "Not found");

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const parsed = await parseJson(req, BodySchema);
  if ("response" in parsed) return parsed.response;

  // Access first: callers without a valid link learn nothing about the question rules.
  if (!isUuid(id)) return notFound();
  const shared = await getReferralByToken(parsed.data.share_token);
  if (!shared || shared.referral.case_id !== id) return notFound();
  const { referral } = shared;

  const checked = QuestionSchema.safeParse({ question: parsed.data.question });
  if (!checked.success) return fail(400, "Invalid request", fieldErrors(checked.error));
  const question = checked.data.question;

  const context = buildAskContext(await loadAskCase(id));

  const reservation = await reserveQuestion(referral.id, question);
  if (!reservation.ok) {
    return reservation.reason === "limit" ? fail(429, "Question limit reached for this referral") : notFound();
  }

  let result: AskResult;
  try {
    const answer = await generateJson({
      task: "ask",
      system: askSystemPrompt(),
      prompt: buildAskPrompt(question, context.text),
      schema: AskAnswerSchema,
    });
    result = resolveAnswer(answer, context.citable);
  } catch (err) {
    await releaseQuestion(reservation.questionId).catch((releaseErr: unknown) => {
      console.error(`ask: could not release reservation: ${String(releaseErr)}`);
    });
    if (err instanceof GeminiError) {
      console.error(`ask failed: ${err.message}`);
      return fail(502, "The question could not be answered");
    }
    throw err;
  }

  if (!(await completeQuestion(reservation.questionId, result))) return notFound();

  await audit({
    caseId: id,
    actor: "specialist",
    action: "case.question_asked",
    entity: "case_question",
    entityId: reservation.questionId,
    details: { referral_id: referral.id, found: result.found, citations: result.citations.length },
  });

  return ok(result);
}
