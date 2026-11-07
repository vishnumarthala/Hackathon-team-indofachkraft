import { z } from "zod";
import { isDemoMode } from "@/lib/demo";
import { getConversation } from "@/lib/elevenlabs/agent";
import { env } from "@/lib/env";
import { fail, ok, parseJson } from "@/lib/http";
import { demoPostCallData, InvalidPostCallError, processPostCall, PostCallDataSchema } from "@/lib/intake/process";
import { getCaseByToken } from "@/lib/queries/intake";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  conversation_id: z
    .string({ error: "conversation_id is required" })
    .regex(/^[A-Za-z0-9_-]{1,128}$/, "conversation_id is not valid"),
});

const PENDING = new Set(["initiated", "in-progress", "processing"]);
const PROVIDER_FAILED = "Could not retrieve the call from ElevenLabs";
const SAVE_FAILED = "Could not save the call";

export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const parsed = await parseJson(req, bodySchema);
  if ("response" in parsed) return parsed.response;
  const conversationId = parsed.data.conversation_id;

  const caseRow = await getCaseByToken(token);
  if (!caseRow) return fail(404, "This link is not valid.");

  if (isDemoMode()) return processAndAnswer(() => demoPostCallData(token, conversationId));

  let conversation: Record<string, unknown>;
  try {
    conversation = await getConversation(conversationId);
  } catch (err) {
    console.error(`intake complete: ${err instanceof Error ? err.message : String(err)}`);
    return fail(502, PROVIDER_FAILED);
  }

  const status = conversation.status;
  if (typeof status !== "string") return fail(502, "Unexpected response from ElevenLabs");
  if (conversation.agent_id !== env.ELEVENLABS_AGENT_ID) {
    return fail(403, "This call does not belong to this intake link");
  }
  // While the call is still running the token may not be reported yet; it is required before processing.
  const reportedToken = (
    conversation.conversation_initiation_client_data as { dynamic_variables?: { intake_token?: unknown } } | undefined
  )?.dynamic_variables?.intake_token;
  if ((status === "done" || reportedToken !== undefined) && reportedToken !== token) {
    return fail(403, "This call does not belong to this intake link");
  }
  if (typeof conversation.conversation_id === "string" && conversation.conversation_id !== conversationId) {
    return fail(403, "This call does not belong to this intake link");
  }

  if (PENDING.has(status)) return ok({ status: "processing" }, 202);
  if (status === "failed") return fail(502, "The call failed at ElevenLabs. Please try the call again.");
  if (status !== "done") return fail(502, `Unexpected call status from ElevenLabs: ${status.slice(0, 40)}`);

  const data = PostCallDataSchema.safeParse({ ...conversation, conversation_id: conversationId });
  if (!data.success) return fail(502, "Unexpected response from ElevenLabs");
  return processAndAnswer(() => data.data);
}

async function processAndAnswer(load: () => unknown) {
  try {
    return ok(await processPostCall(load()));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`intake complete: ${message}`);
    if (err instanceof InvalidPostCallError) return fail(502, "Unexpected call data");
    return fail(500, SAVE_FAILED);
  }
}
