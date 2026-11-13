import { NextResponse } from "next/server";
import { confirmUrl } from "@/lib/agents/booking/constants";
import { bookingDemoScript } from "@/lib/agents/booking/demo";
import { agentSessionLimiter, rateKey } from "@/lib/agents/booking/rate-limit";
import { agentSessionCookie, cookieAgentToken, createAgentSession, endAgentSession, getAgentSession } from "@/lib/agents/booking/session";
import { resolveCallLanguage } from "@/lib/agents/call-language";
import { bookingSessionCookie, ensureBookingSession } from "@/lib/booking/session";
import { getOwnedHold } from "@/lib/booking/store";
import { todayIn } from "@/lib/booking/time";
import { isDemoMode } from "@/lib/demo";
import { startAgentSession, type AgentStart } from "@/lib/elevenlabs/agent";
import { env } from "@/lib/env";
import { fail, ok } from "@/lib/http";
import { voiceGate } from "@/lib/voice/gate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const VOICE_BOOKING_UNAVAILABLE = "Voice booking is not available right now. Please use the search below.";
export const RATE_LIMITED = "Too many voice bookings started from this connection. Please try again later.";
const NO_SESSION = "No voice booking session";

const DEFAULT_TIME_ZONE = "Asia/Kolkata";

function todayLabel(now = new Date()): string {
  const date = todayIn(DEFAULT_TIME_ZONE, now);
  const weekday = new Intl.DateTimeFormat("en-IN", { weekday: "long", timeZone: DEFAULT_TIME_ZONE }).format(now);
  return `${weekday} ${date}`;
}

// Ticket 034 FR-2 (public, lib/auth-access.ts): starts a voice booking session. 5 per IP per hour. Returns the
// conversation token for the private booking agent and the random `booking_session` the agent sends with every tool
// call. DEMO_MODE never contacts ElevenLabs (`demo: true`, the widget runs a scripted conversation). Holds are owned
// by this browser's 030 booking session (`dnm_booking` cookie), so the normal confirm flow attaches them after sign-in.
// 051: voice needs a signed-in user, the Turnstile check (when configured) and room in the user's `booking` quota and
// the platform budget (lib/voice/gate.ts), before ElevenLabs is contacted. Searching and booking by tapping on /find
// stay anonymous. The widget reports the end of the call (POST /api/voice/usage/:id/end).
// 049: optional JSON body `{ language }` (default the viewer's UI locale). A language the agent does not have
// (ELEVENLABS_BOOKING_LANGUAGES) -> 409 `language_unavailable` before the gate; the widget then offers "Voice in
// English" or tapping. DEMO_MODE returns the scripted conversation in the call language (`demo_script`).
export async function POST(req: Request) {
  if (!agentSessionLimiter.allow(rateKey(req))) {
    return NextResponse.json({ error: RATE_LIMITED }, { status: 429, headers: { "Retry-After": "3600" } });
  }
  const body = (await req.json().catch(() => null)) as { language?: unknown } | null;
  const demo = isDemoMode();
  const agentId = env.ELEVENLABS_BOOKING_AGENT_ID;
  // Without the tool secret every tool call would be refused: do not start a call that cannot work.
  if (!demo && (!agentId || !env.ELEVENLABS_TOOL_SECRET)) return fail(503, VOICE_BOOKING_UNAVAILABLE);
  const call = await resolveCallLanguage("booking", body?.language);
  if (!call.ok) return call.response;
  const { language } = call;
  const gate = await voiceGate(req, "booking", { turnstile: true });
  if ("response" in gate) return gate.response;

  let voice: AgentStart | null = null;
  if (!demo) {
    try {
      voice = await startAgentSession(agentId as string, { language });
    } catch (err) {
      await gate.release();
      console.error(`booking voice start failed: ${err instanceof Error ? err.message : String(err)}`);
      return fail(502, VOICE_BOOKING_UNAVAILABLE);
    }
  }

  const owner = await ensureBookingSession();
  const { token, session } = await createAgentSession(owner.hash, { demo });
  const res = ok(
    {
      booking_session: token,
      expires_at: session.expires_at,
      conversation_token: voice?.conversation_token ?? null,
      ...(voice ? { agent_id: voice.agent_id } : {}),
      ...(demo ? { demo: true, demo_script: bookingDemoScript(language) } : {}),
      voice_usage_id: gate.usageId,
      max_seconds: gate.maxSeconds,
      language,
      // FR-1: the only values the agent receives. No names, no contact details.
      dynamic_variables: { booking_session: token, today: todayLabel(), language },
    },
    201,
  );
  if (owner.created) res.cookies.set(bookingSessionCookie(owner.id));
  res.cookies.set(agentSessionCookie(token));
  return res;
}

// FR-4: the widget's view of its own session (cookie-bound): the current hold, if any. No other browser can read it.
export async function GET() {
  const session = await getAgentSession(await cookieAgentToken());
  if (!session) return fail(404, NO_SESSION);
  let hold = null;
  if (session.hold_appointment_id) {
    const held = await getOwnedHold(session.hold_appointment_id, { userId: null, sessionHash: session.owner_session_hash });
    if (held && held.status === "held" && held.hold_expires_at && Date.parse(held.hold_expires_at) > Date.now()) {
      hold = {
        appointment_id: held.id,
        profile_id: held.provider_profile_id,
        provider_name: held.provider_name,
        service_name: held.service_snapshot.name,
        mode: held.service_snapshot.mode,
        payment_mode: held.service_snapshot.payment_mode,
        fee_inr: held.service_snapshot.fee_inr,
        start: held.starts_at,
        end: held.ends_at,
        time_zone: held.service_snapshot.time_zone ?? held.provider_time_zone,
        expires_at: held.hold_expires_at,
        confirm_url: confirmUrl(held.provider_profile_id, held.id),
      };
    }
  }
  const active = !session.ended_at && Date.parse(session.expires_at) > Date.now();
  return ok({ active, expires_at: session.expires_at, hold });
}

// The parent ended the call, or a red flag stopped it (FR-1): later tool calls for this session get 401. The cookie
// stays so the widget can still show a hold placed before the end.
export async function DELETE() {
  const token = await cookieAgentToken();
  if (!token || !(await getAgentSession(token))) return fail(404, NO_SESSION);
  await endAgentSession(token);
  return ok({ ended: true });
}
