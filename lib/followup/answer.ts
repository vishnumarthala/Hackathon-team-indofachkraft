// Ticket 040 FR-2 / FR-3: one pipeline for every follow-up question, typed (text chat) or spoken (the voice agent's
// `answer_question` tool). Callers have already checked that the guardian is signed in (or holds a valid voice
// session) and that `ai_follow_up` consent was granted when the chat or call started. Order:
//   1. red flag (shared classifier)      -> 108/112 message, no model, nothing stored, audit without text
//   2. daily limit (30, atomic)          -> 429
//   3. medicine change / condition asks  -> fixed answer, no model
//   4. consent re-check (assertConsentOrAbort, 020) before any data reaches the model -> 422
//   5. authorised context (FR-1)         -> 404 when the guardian link is gone
//   6. model (Gemini, or the DEMO fixture) -> answer resolved against the documents sent
import { audit, type SessionAuditActor } from "@/lib/audit";
import { classifyRedFlagText } from "@/lib/clinical/red-flags";
import { assertConsentOrAbort, consentRequired } from "@/lib/consent";
import { GeminiError } from "@/lib/gemini";
import { fail, ok } from "@/lib/http";
import { logger } from "@/lib/log";
import {
  DAILY_QUESTION_LIMIT,
  fixedAnswer,
  isDiagnosisQuestion,
  isMedicineChangeQuestion,
  type FollowupAnswer,
  type FollowupChannel,
} from "./constants";
import { loadGuardianContext } from "./context";
import { buildFollowupPrompt, defaultGenerate, followupSystemPrompt, resolveModelAnswer, type Generate } from "./model";
import { completeQuestion, releaseQuestion, reserveQuestion } from "./store";

const log = logger("followup");

export const LIMIT_REACHED = `You have asked ${DAILY_QUESTION_LIMIT} questions today. Please try again tomorrow, or ask your provider using Messages.`;
export const ANSWER_FAILED = "The question could not be answered. Please try again.";
export const CHILD_NOT_FOUND = "Child not found";

export type AskInput = {
  guardianUserId: string;
  childId: string;
  question: string;
  channel: FollowupChannel;
  timeZone?: string;
  /** Tests inject a fake model; production uses Gemini (or the DEMO fixture). */
  generate?: Generate;
};

export type AskOutcome = { response: Response; redFlag: boolean };

function actorOf(input: AskInput): SessionAuditActor {
  return { actor: "guardian", actorUserId: input.guardianUserId, actorRole: "guardian" };
}

async function stored(id: string, input: AskInput, answer: FollowupAnswer, started: number): Promise<Response> {
  if (!(await completeQuestion(id, answer))) return fail(404, CHILD_NOT_FOUND);
  await audit({
    ...actorOf(input),
    childId: input.childId,
    action: "followup.question_asked",
    entity: "followup_question",
    entityId: id,
    details: { found: answer.found, citations: answer.citations.length, safety: answer.safety ?? null, channel: input.channel },
  });
  log.info("answered", { channel: input.channel, found: answer.found, safety: answer.safety ?? null, ms: Math.round(performance.now() - started) });
  return ok({ id, ...answer });
}

export async function answerQuestion(input: AskInput): Promise<AskOutcome> {
  const started = performance.now();

  // FR-3: before anything else (even the daily limit): the safety message must always get through.
  const redFlag = classifyRedFlagText(input.question);
  if (redFlag) {
    await audit({
      ...actorOf(input),
      childId: input.childId,
      action: "followup.red_flag",
      entity: "child",
      entityId: input.childId,
      details: { code: redFlag, channel: input.channel },
    });
    log.info("red flag", { channel: input.channel, code: redFlag });
    return { response: ok(fixedAnswer("red_flag")), redFlag: true };
  }

  const reservation = await reserveQuestion({
    guardianUserId: input.guardianUserId,
    childId: input.childId,
    question: input.question,
    channel: input.channel,
  });
  if (!reservation.ok) {
    return { response: Response.json({ error: LIMIT_REACHED }, { status: 429, headers: { "Retry-After": "3600" } }), redFlag: false };
  }
  const id = reservation.id;

  if (isMedicineChangeQuestion(input.question)) return { response: await stored(id, input, fixedAnswer("medicine"), started), redFlag: false };
  if (isDiagnosisQuestion(input.question)) return { response: await stored(id, input, fixedAnswer("diagnosis"), started), redFlag: false };

  // 020: re-check before each question reaches the model (consent may have been withdrawn mid-chat or mid-call).
  if (!(await assertConsentOrAbort(input.childId, "ai_follow_up", { stage: `followup.${input.channel}_question` }))) {
    await releaseQuestion(id);
    return { response: consentRequired(input.childId, "ai_follow_up"), redFlag: false };
  }

  const context = await loadGuardianContext(input.guardianUserId, input.childId, { timeZone: input.timeZone });
  if (!context) {
    await releaseQuestion(id);
    return { response: fail(404, CHILD_NOT_FOUND), redFlag: false };
  }
  if (context.citable.size === 0) return { response: await stored(id, input, fixedAnswer("not_found"), started), redFlag: false };

  let answer: FollowupAnswer;
  try {
    const generate = input.generate ?? defaultGenerate;
    const raw = await generate({
      system: followupSystemPrompt(),
      prompt: buildFollowupPrompt(input.question, context.text),
      question: input.question,
    });
    answer = resolveModelAnswer(raw, context);
  } catch (err) {
    await releaseQuestion(id).catch(() => {});
    if (err instanceof GeminiError) {
      log.error("model failed", { error: err.message });
      return { response: fail(502, ANSWER_FAILED), redFlag: false };
    }
    throw err;
  }
  return { response: await stored(id, input, answer, started), redFlag: answer.safety === "red_flag" };
}
