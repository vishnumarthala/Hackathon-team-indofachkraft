// Ticket 035 FR-5: the intake page reports a finished appointment intake call (same contract as 010's
// /api/intake/:token/complete). The call must come from the attempt's agent and name this link's attempt
// (`intake_attempt_id`); a call of another appointment is refused (403). Idempotent by conversation_id.
import { z } from "zod";
import { requireConsent } from "@/lib/consent";
import { isDemoMode } from "@/lib/demo";
import { getConversation } from "@/lib/elevenlabs/agent";
import { fail, ok, parseJson } from "@/lib/http";
import {
  agentMatches,
  AppointmentPostCallSchema,
  AttemptMismatchError,
  demoAppointmentPostCall,
  processAppointmentPostCall,
} from "@/lib/intake/appointment-process";
import { attemptLinkState, getAttemptByToken } from "@/lib/intake/attempts";
import { INTAKE_COMPLETION_GRACE_MS, LINK_EXPIRED } from "@/lib/intake/link";
import { InvalidPostCallError } from "@/lib/intake/process";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  conversation_id: z
    .string({ error: "conversation_id is required" })
    .regex(/^[A-Za-z0-9_-]{1,128}$/, "conversation_id is not valid"),
});

const PENDING = new Set(["initiated", "in-progress", "processing"]);
const MISMATCH = "This call does not belong to this intake link";

export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const parsed = await parseJson(req, bodySchema);
  if ("response" in parsed) return parsed.response;
  const conversationId = parsed.data.conversation_id;

  const attempt = await getAttemptByToken(token);
  if (!attempt) return fail(404, "This link is not valid.");
  const state = attemptLinkState(attempt, Date.now(), INTAKE_COMPLETION_GRACE_MS);
  // A completed attempt still answers: the same conversation -> duplicate, another one -> ignored.
  if ((state !== "active" && state !== "completed") || !attempt.child_id) return fail(410, LINK_EXPIRED);
  const blocked = await requireConsent(attempt.child_id, "ai_intake_call");
  if (blocked) return blocked;

  if (isDemoMode()) return processAndAnswer(() => demoAppointmentPostCall(attempt, conversationId), attempt.id);

  let conversation: Record<string, unknown>;
  try {
    conversation = await getConversation(conversationId);
  } catch (err) {
    console.error(`appointment intake complete: ${err instanceof Error ? err.message : String(err)}`);
    return fail(502, "Could not retrieve the call from ElevenLabs");
  }
  const status = conversation.status;
  if (typeof status !== "string") return fail(502, "Unexpected response from ElevenLabs");
  if (!agentMatches(attempt.agent_kind, typeof conversation.agent_id === "string" ? conversation.agent_id : undefined)) {
    return fail(403, MISMATCH);
  }
  const reported = (
    conversation.conversation_initiation_client_data as { dynamic_variables?: { intake_attempt_id?: unknown } } | undefined
  )?.dynamic_variables?.intake_attempt_id;
  if ((status === "done" || reported !== undefined) && reported !== attempt.id) return fail(403, MISMATCH);
  if (typeof conversation.conversation_id === "string" && conversation.conversation_id !== conversationId) {
    return fail(403, MISMATCH);
  }

  if (PENDING.has(status)) return ok({ status: "processing" }, 202);
  if (status === "failed") return fail(502, "The call failed at ElevenLabs. Please try the call again.");
  if (status !== "done") return fail(502, `Unexpected call status from ElevenLabs: ${status.slice(0, 40)}`);

  const data = AppointmentPostCallSchema.safeParse({ ...conversation, conversation_id: conversationId });
  if (!data.success) return fail(502, "Unexpected response from ElevenLabs");
  return processAndAnswer(() => data.data, attempt.id);
}

async function processAndAnswer(load: () => unknown, attemptId: string) {
  try {
    return ok(await processAppointmentPostCall(load(), { expectedAttemptId: attemptId }));
  } catch (err) {
    if (err instanceof AttemptMismatchError) return fail(403, MISMATCH);
    console.error(`appointment intake complete: ${err instanceof Error ? err.message : String(err)}`);
    if (err instanceof InvalidPostCallError) return fail(502, "Unexpected call data");
    return fail(500, "Could not save the call");
  }
}
