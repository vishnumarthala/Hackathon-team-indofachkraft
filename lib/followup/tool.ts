// Ticket 040 FR-5: the voice agent's server tool `answer_question { followup_session, question }`. Auth order: shared
// secret `X-Agent-Secret` (live ElevenLabs; 034's ELEVENLABS_TOOL_SECRET) or, for the DEMO_MODE voice panel, the
// signed-in guardian who owns the session -> per-IP burst limit -> JSON body -> a valid (unexpired, not ended) session,
// charged one call -> the guardian's link is still active and `ai_follow_up` still granted -> the same pipeline as the
// text chat (lib/followup/answer.ts). Expired, ended, unknown or another guardian's session -> 401. Nothing from the
// payload is logged. 049: a Hindi or Telugu session gets its fixed answers in that language and model answers marked
// `translate: true` (lib/agents/followup/localize.ts); the pipeline itself stays English.
import { createHash, randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { verifyAgentSecret } from "@/lib/agents/booking/session";
import { localizeToolAnswer } from "@/lib/agents/followup/localize";
import { getActiveGuardianLink } from "@/lib/children";
import { requireConsent } from "@/lib/consent";
import { clientIp, createRateLimiter } from "@/lib/geo/rate-limit";
import { fail, fieldErrors } from "@/lib/http";
import { logger } from "@/lib/log";
import { answerQuestion } from "./answer";
import { QuestionSchema } from "./constants";
import type { Generate } from "./model";
import { chargeToolCall, endFollowupSession } from "./session";

const log = logger("followup-agent");

export const INVALID_SESSION = "Invalid or expired follow-up session";
export const TOO_MANY_CALLS = "Too many questions in this voice session";

const SALT = randomBytes(16).toString("hex");
const rateKey = (req: Request) => createHash("sha256").update(`${SALT}:${clientIp(req)}`).digest("hex");
/** ElevenLabs calls from a few shared egress IPs: this only caps bursts; the real limits are per session and guardian. */
export const followupToolLimiter = createRateLimiter({ limit: 120, windowMs: 60_000 });

export type ToolAuth = { kind: "secret" } | { kind: "guardian"; userId: string };

export async function handleAnswerTool(req: Request, auth: ToolAuth, opts: { generate?: Generate } = {}): Promise<Response> {
  const started = performance.now();
  const done = (res: Response) => {
    log.info("tool call", { tool: "answer_question", auth: auth.kind, status: res.status, ms: Math.round(performance.now() - started) });
    return res;
  };

  if (auth.kind === "secret" && !verifyAgentSecret(req)) return done(fail(401, "Unauthorized"));
  if (!followupToolLimiter.allow(rateKey(req))) {
    return done(NextResponse.json({ error: "Too many requests. Try again later." }, { status: 429, headers: { "Retry-After": "60" } }));
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return done(fail(400, "Invalid request", { body: "Body must be JSON" }));
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return done(fail(400, "Invalid request", { body: "Body must be a JSON object" }));
  }
  const record = body as Record<string, unknown>;
  const token = typeof record.followup_session === "string" ? record.followup_session : "";

  const gate = await chargeToolCall(token, auth.kind === "guardian" ? { guardianUserId: auth.userId } : {});
  if (!gate.ok) return done(gate.status === 429 ? fail(429, TOO_MANY_CALLS) : fail(401, INVALID_SESSION));
  const { session } = gate;

  // The session was bound at start; the guardian must still be linked (revoked link -> the session is dead).
  if (!(await getActiveGuardianLink(session.child_id, session.guardian_user_id))) {
    await endFollowupSession(token);
    return done(fail(401, INVALID_SESSION));
  }
  const denied = await requireConsent(session.child_id, "ai_follow_up");
  if (denied) {
    await endFollowupSession(token);
    return done(denied);
  }

  const parsed = QuestionSchema.safeParse({ question: record.question });
  if (!parsed.success) return done(fail(400, "Invalid request", fieldErrors(parsed.error)));

  const outcome = await answerQuestion({
    guardianUserId: session.guardian_user_id,
    childId: session.child_id,
    question: parsed.data.question,
    channel: "voice",
    generate: opts.generate,
  });
  // FR-3: after a red flag the agent says the 108/112 message and the call ends; no further questions.
  if (outcome.redFlag) await endFollowupSession(token);
  if (session.language === "en" || !outcome.response.ok) return done(outcome.response);
  const answered = (await outcome.response.json()) as Record<string, unknown>;
  return done(NextResponse.json(localizeToolAnswer(answered, session.language), { status: outcome.response.status }));
}
