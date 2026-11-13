import { handleToolCall } from "@/lib/agents/booking/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Ticket 034 FR-3: ElevenLabs server tool `search_providers`. Public in lib/auth-access.ts; authenticated by
// `X-Agent-Secret` and the per-conversation `booking_session` in the body (lib/agents/booking/handler.ts).
export async function POST(req: Request) {
  return handleToolCall(req, "search_providers", "secret");
}
