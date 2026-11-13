import { fail, ok, parseJson } from "@/lib/http";
import { AnswersSchema } from "@/lib/screen/questions";
import { recordAnswers } from "@/lib/screen/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Ticket 033 FR-4: public. Stores answers (form taps or the voice agent's `record_answer` client tool). A red-flag
// question answered `yes` stops the check-in (`stop: true`, FR-7).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const parsed = await parseJson(req, AnswersSchema);
  if ("response" in parsed) return parsed.response;
  const saved = await recordAnswers(id, parsed.data.answers, parsed.data.conversation_id);
  if (!saved.ok) return fail(saved.status, saved.error, saved.details);
  return ok({ missing: saved.missing, stop: saved.stop });
}
