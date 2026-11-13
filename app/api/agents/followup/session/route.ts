import { z } from "zod";
import { requireChildGuardian, requireGuardian } from "@/lib/authz";
import { requireConsent } from "@/lib/consent";
import { isDemoMode } from "@/lib/demo";
import { startAgentSession, type AgentStart } from "@/lib/elevenlabs/agent";
import { env } from "@/lib/env";
import { createFollowupSession, endFollowupSession } from "@/lib/followup/session";
import { fail, ok, parseJson } from "@/lib/http";
import { logger } from "@/lib/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const log = logger("followup-agent");

export const VOICE_UNAVAILABLE = "Voice questions are not available right now. Please type your question.";

const StartSchema = z.object({ child_id: z.string().uuid("Child not found") }).strict();
const EndSchema = z
  .object({
    followup_session: z.string().max(100),
    conversation_id: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/).nullable().optional(),
  })
  .strict();

// Ticket 040 FR-5: `Ask by voice`. Signed-in guardian of the child, `ai_follow_up` consent at session start (else 422).
// Returns a 15-minute `followup_session` bound to (guardian, child) and the conversation token of the private
// English-only agent. DEMO_MODE never contacts ElevenLabs (`demo: true`; the page runs the demo voice panel against
// the same tool handler).
export async function POST(req: Request) {
  const session = await requireGuardian();
  if (session instanceof Response) return session;
  const parsed = await parseJson(req, StartSchema);
  if ("response" in parsed) return parsed.response;
  const access = await requireChildGuardian(parsed.data.child_id, session);
  if (access instanceof Response) return access;
  const denied = await requireConsent(access.child.id, "ai_follow_up");
  if (denied) return denied;

  const demo = isDemoMode();
  let voice: AgentStart | null = null;
  if (!demo) {
    const agentId = env.ELEVENLABS_FOLLOWUP_AGENT_ID;
    // Without the tool secret every tool call would be refused: do not start a call that cannot work.
    if (!agentId || !env.ELEVENLABS_TOOL_SECRET) return fail(503, VOICE_UNAVAILABLE);
    try {
      voice = await startAgentSession(agentId);
    } catch (err) {
      log.error("voice start failed", { error: err instanceof Error ? err.message : String(err) });
      return fail(502, VOICE_UNAVAILABLE);
    }
  }

  const { token, session: created } = await createFollowupSession({ guardianUserId: session.user.id, childId: access.child.id, demo });
  return ok(
    {
      followup_session: token,
      expires_at: created.expires_at,
      conversation_token: voice?.conversation_token ?? null,
      ...(voice ? { agent_id: voice.agent_id } : {}),
      ...(demo ? { demo: true } : {}),
      // The only value the agent receives: no child or guardian names.
      dynamic_variables: { followup_session: token },
    },
    201,
  );
}

// The call ended (or a red flag stopped it): later tool calls for this session get 401. The browser may attach the
// ElevenLabs conversation id once so erasure (041) can delete the processor's copy.
export async function DELETE(req: Request) {
  const session = await requireGuardian();
  if (session instanceof Response) return session;
  const parsed = await parseJson(req, EndSchema);
  if ("response" in parsed) return parsed.response;
  const ended = await endFollowupSession(parsed.data.followup_session, {
    guardianUserId: session.user.id,
    conversationId: parsed.data.conversation_id ?? null,
  });
  return ended ? ok({ ended: true }) : fail(404, "No voice session");
}
