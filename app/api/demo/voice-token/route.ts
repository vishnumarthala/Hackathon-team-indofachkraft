import { audit } from "@/lib/audit";
import { DEMO_CENTRE_NAME, startAgentSession, type AgentVariables } from "@/lib/elevenlabs/agent";
import { fail, ok } from "@/lib/http";
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

export async function POST(req: Request) {
  if (!process.env.ELEVENLABS_AGENT_ID) return fail(503, "Live demo unavailable");
  if (!allowVoiceDemo(clientIp(req))) {
    return fail(429, "The live demo is busy. Please listen to the sample call or try again in a few minutes.");
  }

  let session: Awaited<ReturnType<typeof startAgentSession>>;
  try {
    session = await startAgentSession();
  } catch (err) {
    console.error(`voice demo start failed: ${err instanceof Error ? err.message : String(err)}`);
    return fail(502, "Could not start the demo call");
  }

  await audit({
    actor: "system",
    action: "landing.voice_demo_started",
    entity: "voice_demo",
    details: { token: session.conversation_token !== null },
  });
  return ok({ ...session, dynamic_variables: DEMO_VARIABLES });
}
