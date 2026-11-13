import { handleToolCall } from "@/lib/agents/booking/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Ticket 034 FR-3: ElevenLabs server tool `hold_slot`. Public in lib/auth-access.ts; authenticated by
// `X-Agent-Secret` and the per-conversation `booking_session` in the body (lib/agents/booking/handler.ts).
// Places a 10-minute hold only: there is no confirm tool (D-2).
export async function POST(req: Request) {
  return handleToolCall(req, "hold_slot", "secret");
}
