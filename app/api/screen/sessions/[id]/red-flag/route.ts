import { fail, ok, parseJson } from "@/lib/http";
import { RedFlagSchema } from "@/lib/screen/questions";
import { recordRedFlag } from "@/lib/screen/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Ticket 033 FR-4 / FR-7: public. The agent's `record_red_flag` client tool (or the form): the check-in stops, the
// code is stored, and the page shows only the 108/112 message.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const parsed = await parseJson(req, RedFlagSchema);
  if ("response" in parsed) return parsed.response;
  const saved = await recordRedFlag(id, parsed.data.code, parsed.data.conversation_id);
  if (!saved.ok) return fail(saved.status, saved.error, saved.details);
  return ok({ stop: true });
}
