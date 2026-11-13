import { z } from "zod";
import { getAuthenticatedUser } from "@/lib/auth";
import { fail, ok, parseJson } from "@/lib/http";
import { endVoiceUsage } from "@/lib/voice/usage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EndSchema = z
  .object({
    duration_seconds: z.number().min(0).max(86_400),
    conversation_id: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/).nullable().optional(),
  })
  .strict();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 051 FR-7: the browser reports the end of its own voice call. The duration is clamped to the reserved seconds (and the
// time since the start). Only the user who started the call: anyone else's id (or an unknown one) is 404.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthenticatedUser();
  if (!user) return fail(401, "Authentication required");
  const { id } = await params;
  if (!UUID_RE.test(id)) return fail(404, "Voice session not found");
  const parsed = await parseJson(req, EndSchema);
  if ("response" in parsed) return parsed.response;
  const ended = await endVoiceUsage({
    usageId: id,
    userId: user.id,
    seconds: parsed.data.duration_seconds,
    conversationId: parsed.data.conversation_id ?? null,
  });
  if (!ended) return fail(404, "Voice session not found");
  return ok({ status: ended.status, actual_seconds: ended.actual_seconds });
}
