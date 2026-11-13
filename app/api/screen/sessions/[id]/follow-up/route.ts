import { fail, ok, parseJson } from "@/lib/http";
import { FollowUpSchema } from "@/lib/screen/questions";
import { recordFollowUp } from "@/lib/screen/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Ticket 048 FR-3: public, like the other check-in endpoints (the unguessable session id is the only key; saved
// check-ins answer 404). The optional M-CHAT-R/F Follow-Up of a moderate result: pass/fail for every followed-up
// item in one request; returns the updated result. 409 for check-ins without a Follow-Up.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const parsed = await parseJson(req, FollowUpSchema);
  if ("response" in parsed) return parsed.response;
  const done = await recordFollowUp(id, parsed.data.answers);
  if (!done.ok) return fail(done.status, done.error, done.details);
  return ok(done.result);
}
