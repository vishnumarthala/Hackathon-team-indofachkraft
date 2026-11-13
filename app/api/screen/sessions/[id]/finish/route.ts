import { fail, fieldErrors, ok } from "@/lib/http";
import { FinishSchema } from "@/lib/screen/questions";
import { finishSession } from "@/lib/screen/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Ticket 033 FR-4: public. `{ result_band, domains, red_flag, message }` computed server-side with 024's scorer.
// A stopped (red-flag) check-in returns `red_flag: true` and no band. The body (`{ conversation_id }`) is optional.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const text = await req.text().catch(() => "");
  let conversationId: string | undefined;
  if (text.trim()) {
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return fail(400, "Invalid request", { body: "Body must be JSON" });
    }
    const parsed = FinishSchema.safeParse(body);
    if (!parsed.success) return fail(400, "Invalid request", fieldErrors(parsed.error));
    conversationId = parsed.data.conversation_id;
  }
  const finished = await finishSession(id, conversationId);
  if (!finished.ok) return fail(finished.status, finished.error, finished.details);
  return ok(finished.result);
}
