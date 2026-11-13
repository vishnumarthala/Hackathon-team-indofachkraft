import { isDemoMode } from "@/lib/demo";
import { env } from "@/lib/env";
import { startAgentSession, type AgentStart } from "@/lib/elevenlabs/agent";
import { fail, ok, parseJson } from "@/lib/http";
import { agentQuestionList, CreateSessionSchema, instrumentFor, screenQuestions, SPOKEN_AGE_BAND } from "@/lib/screen/questions";
import { allowScreenSession } from "@/lib/screen/rate-limit";
import { createScreenSession } from "@/lib/screen/store";
import { voiceGate, type VoiceGrant } from "@/lib/voice/gate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const VOICE_UNAVAILABLE = "Voice check-in is not available right now. Please answer by tapping instead.";
export const RATE_LIMITED = "Too many check-ins started from this connection. Please try again later.";

// Ticket 033 FR-4: public (lib/auth-access.ts). Starts an anonymous check-in: age band + mode only (rule 6); 048 adds
// the parent's worries as codes (FR-5) and rejects the bands without questions (`under-18m`, `9y+`: 400).
// Voice: a conversation token for the private screen agent, minted before the session row exists so a provider
// failure leaves nothing behind. DEMO_MODE never contacts ElevenLabs (`demo: true`).
// 051: tapping stays anonymous; voice needs a signed-in user, the Turnstile check (when configured) and room in the
// user's quota and the platform budget (lib/voice/gate.ts), all before ElevenLabs is contacted. The check-in itself
// stays anonymous with respect to the child: only `voice_usage` links the account to "a voice check-in happened".
export async function POST(req: Request) {
  if (!allowScreenSession(req)) {
    return Response.json({ error: RATE_LIMITED }, { status: 429, headers: { "Retry-After": "3600" } });
  }
  const parsed = await parseJson(req, CreateSessionSchema);
  if ("response" in parsed) return parsed.response;
  const { age_band, mode, concerns } = parsed.data;
  // 048 FR-3: the instrument is fixed for the session (M-CHAT-R/F for 18-30 months only when licensed).
  const instrument = instrumentFor(age_band, env.MCHAT_LICENSED);
  const questions = screenQuestions(age_band, instrument);

  let voice: AgentStart | null = null;
  let grant: VoiceGrant | null = null;
  const demo = mode === "voice" && isDemoMode();
  if (mode === "voice") {
    const agentId = env.ELEVENLABS_SCREEN_AGENT_ID;
    if (!demo && !agentId) return fail(503, VOICE_UNAVAILABLE);
    const gate = await voiceGate(req, "screen", { turnstile: true });
    if ("response" in gate) return gate.response;
    grant = gate;
    if (!demo) {
      try {
        voice = await startAgentSession(agentId as string);
      } catch (err) {
        await grant.release();
        console.error(`screen voice start failed: ${err instanceof Error ? err.message : String(err)}`);
        return fail(502, VOICE_UNAVAILABLE);
      }
    }
  }

  const session = await createScreenSession(age_band, mode, { instrument, concerns });
  const base = { session_id: session.id, expires_at: session.expires_at.toISOString(), questions };
  if (demo) {
    // No live call in DEMO_MODE: the start counts against the quota with 0 seconds and the page continues by tapping.
    await grant?.endNow();
    return ok({ ...base, demo: true }, 201);
  }
  if (!voice || !grant) return ok(base, 201);
  return ok(
    {
      ...base,
      conversation_token: voice.conversation_token,
      agent_id: voice.agent_id,
      voice_usage_id: grant.usageId,
      max_seconds: grant.maxSeconds,
      // FR-3: the only values the agent receives. No names, no contact details.
      dynamic_variables: {
        screen_session_id: session.id,
        // 048 FR-9: the new bands, as the agent should say them ("2 and a half to 5 years").
        age_band: SPOKEN_AGE_BAND[age_band],
        questions: agentQuestionList(questions),
      },
    },
    201,
  );
}
