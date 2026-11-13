import { requireGuardian } from "@/lib/authz";
import { isDemoMode } from "@/lib/demo";
import { handleAnswerTool } from "@/lib/followup/tool";
import { fail } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Ticket 040 FR-5, DEMO_MODE only (404 otherwise): the demo voice panel calls the same tool handler as the agent,
// authenticated by the signed-in guardian, who must own the session (another guardian's session -> 401).
export async function POST(req: Request) {
  if (!isDemoMode()) return fail(404, "Not found");
  const session = await requireGuardian();
  if (session instanceof Response) return session;
  return handleAnswerTool(req, { kind: "guardian", userId: session.user.id });
}
