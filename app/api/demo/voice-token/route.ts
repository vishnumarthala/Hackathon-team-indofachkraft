import { audit } from "@/lib/audit";
import { getAuthenticatedUser } from "@/lib/auth";
import { DEMO_CENTRE_NAME, startAgentSession, type AgentVariables } from "@/lib/elevenlabs/agent";
import { fail, ok } from "@/lib/http";
import { canUseLiveDemo } from "@/lib/voice/demo-access";
import { refuse, voiceGate } from "@/lib/voice/gate";
import { allowVoiceDemo } from "@/lib/voiceDemoLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Landing page live demo: the visitor plays the parent of a synthetic child. Values come from the server only.
const DEMO_VARIABLES: AgentVariables = {
  parent_name: "Lakshmi",
  child_name: "Ravi",
  centre_name: DEMO_CENTRE_NAME,
  therapist_name: "Demo Therapist",
  case_id: "landing-demo",
};

function clientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || req.headers.get("x-real-ip") || "unknown";
}

// 051 FR-2: the live demo spends ElevenLabs credits, so it is only for signed-in providers (and platform admins) and
// for demo leads with a verified email; 1 per user per day (`intake_demo` quota). Anonymous visitors hear the recorded
// sample and never call this route. The in-memory per-IP limit stays as a cheap first filter.
export async function POST(req: Request) {
  if (!process.env.ELEVENLABS_AGENT_ID) return fail(503, "Live demo unavailable");
  if (!allowVoiceDemo(clientIp(req))) {
    return fail(429, "The live demo is busy. Please listen to the sample call or try again in a few minutes.");
  }
  const user = await getAuthenticatedUser().catch(() => null);
  if (!user) return refuse("signIn");
  if (!(await canUseLiveDemo(user))) return refuse("notAllowed");

  const gate = await voiceGate(req, "intake_demo", { user });
  if ("response" in gate) return gate.response;

  let session: Awaited<ReturnType<typeof startAgentSession>>;
  try {
    session = await startAgentSession();
  } catch (err) {
    await gate.release();
    console.error(`voice demo start failed: ${err instanceof Error ? err.message : String(err)}`);
    return fail(502, "Could not start the demo call");
  }

  await audit({
    actor: "system",
    action: "landing.voice_demo_started",
    entity: "voice_demo",
    details: { token: session.conversation_token !== null },
  });
  return ok({ ...session, dynamic_variables: DEMO_VARIABLES, voice_usage_id: gate.usageId, max_seconds: gate.maxSeconds });
}
