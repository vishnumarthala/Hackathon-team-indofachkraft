import { requireChildGuardian, requireGuardian } from "@/lib/authz";
import { requireConsent } from "@/lib/consent";
import { answerQuestion } from "@/lib/followup/answer";
import { DAILY_QUESTION_LIMIT, QuestionSchema } from "@/lib/followup/constants";
import { listHistory, questionsUsed } from "@/lib/followup/store";
import { ok, parseJson } from "@/lib/http";
import { getTimeZone } from "@/lib/i18n/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Ticket 040 FR-2: a guardian asks about their child's published plans, home programs, shared reports and signed
// prescriptions. Guardian of this child only (other children 404, other roles 403); `ai_follow_up` consent else 422.
// Answers come only from guardian-authorised published versions (lib/followup/context.ts) with citations.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireGuardian();
  if (session instanceof Response) return session;
  const { id } = await params;
  const access = await requireChildGuardian(id, session);
  if (access instanceof Response) return access;
  const denied = await requireConsent(access.child.id, "ai_follow_up");
  if (denied) return denied;

  const parsed = await parseJson(req, QuestionSchema);
  if ("response" in parsed) return parsed.response;

  const { response } = await answerQuestion({
    guardianUserId: session.user.id,
    childId: access.child.id,
    question: parsed.data.question,
    channel: "text",
    timeZone: await getTimeZone(),
  });
  return response;
}

// FR-6: the asking guardian's own questions about this child (newest first) and today's remaining questions.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireGuardian();
  if (session instanceof Response) return session;
  const { id } = await params;
  const access = await requireChildGuardian(id, session);
  if (access instanceof Response) return access;
  const [questions, used] = await Promise.all([listHistory(session.user.id, access.child.id), questionsUsed(session.user.id)]);
  return ok({ questions, remaining_today: Math.max(0, DAILY_QUESTION_LIMIT - used) });
}
