import { fail, ok } from "@/lib/http";
import { getSessionView } from "@/lib/screen/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Ticket 033: public. Resumes a check-in in the same browser (after a reload or after signing in to save it).
// The session id is the only key; saved check-ins (child data) answer 404 here.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const found = await getSessionView(id);
  if (!found.ok) return fail(found.status, found.error, found.details);
  return ok(found.view, 200);
}
