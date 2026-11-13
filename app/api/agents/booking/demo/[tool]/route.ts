import { isAgentTool } from "@/lib/agents/booking/constants";
import { handleToolCall } from "@/lib/agents/booking/handler";
import { isDemoMode } from "@/lib/demo";
import { fail } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Ticket 034 NFR-3: DEMO_MODE only (404 otherwise). The widget's scripted conversation calls the same tool handlers as
// the agent, authenticated by this browser's `dnm_booking_session` cookie instead of the agent secret.
export async function POST(req: Request, { params }: { params: Promise<{ tool: string }> }) {
  const { tool } = await params;
  if (!isDemoMode() || !isAgentTool(tool)) return fail(404, "Not found");
  return handleToolCall(req, tool, "cookie");
}
