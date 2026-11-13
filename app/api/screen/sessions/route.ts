import { isDemoMode } from "@/lib/demo";
import { env } from "@/lib/env";
import { startAgentSession, type AgentStart } from "@/lib/elevenlabs/agent";
import { fail, ok, parseJson } from "@/lib/http";
import { agentQuestionList, CreateSessionSchema, screenQuestions } from "@/lib/screen/questions";
import { allowScreenSession } from "@/lib/screen/rate-limit";
import { createScreenSession } from "@/lib/screen/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const VOICE_UNAVAILABLE = "Voice check-in is not available right now. Please answer by tapping instead.";
export const RATE_LIMITED = "Too many check-ins started from this connection. Please try again later.";

// Ticket 033 FR-4: public (lib/auth-access.ts). Starts an anonymous check-in: age band + mode only (rule 6).
// Voice: a conversation token for the private screen agent, minted before the session row exists so a provider
// failure leaves nothing behind. DEMO_MODE never contacts ElevenLabs (`demo: true`).
export async function POST(req: Request) {
  if (!allowScreenSession(req)) {
    return Response.json({ error: RATE_LIMITED }, { status: 429, headers: { "Retry-After": "3600" } });
  }
  const parsed = await parseJson(req, CreateSessionSchema);
  if ("response" in parsed) return parsed.response;
  const { age_band, mode } = parsed.data;
  const questions = screenQuestions(age_band);

  let voice: AgentStart | null = null;
  const demo = mode === "voice" && isDemoMode();
  if (mode === "voice" && !demo) {
    const agentId = env.ELEVENLABS_SCREEN_AGENT_ID;
    if (!agentId) return fail(503, VOICE_UNAVAILABLE);
    try {
      voice = await startAgentSession(agentId);
    } catch (err) {
      console.error(`screen voice start failed: ${err instanceof Error ? err.message : String(err)}`);
      return fail(502, VOICE_UNAVAILABLE);
    }
  }

  const session = await createScreenSession(age_band, mode);
  const base = { session_id: session.id, expires_at: session.expires_at.toISOString(), questions };
  if (demo) return ok({ ...base, demo: true }, 201);
  if (!voice) return ok(base, 201);
  return ok(
    {
      ...base,
      conversation_token: voice.conversation_token,
      agent_id: voice.agent_id,
      // FR-3: the only values the agent receives. No names, no contact details.
      dynamic_variables: {
        screen_session_id: session.id,
        age_band,
        questions: agentQuestionList(questions),
      },
    },
    201,
  );
}
