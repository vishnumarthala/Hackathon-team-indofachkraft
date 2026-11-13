import { getActiveGuardianLink } from "@/lib/children";
import { fail, fieldErrors, ok, parseJson } from "@/lib/http";
import { canUseCase, requireMessagingUser } from "@/lib/messaging/access";
import { MESSAGING_ERRORS } from "@/lib/messaging/constants";
import { queryObject, ThreadCreateSchema, ThreadListQuery } from "@/lib/messaging/schemas";
import { createThread, listThreads } from "@/lib/messaging/store";

export const dynamic = "force-dynamic";

// 027 FR-2: the caller's conversations (all, one case's or one child's). Guardians: only their linked children;
// providers: only cases they can access under 022's rule. Other ids -> 404.
export async function GET(req: Request) {
  const who = await requireMessagingUser();
  if (who instanceof Response) return who;
  const query = ThreadListQuery.safeParse(queryObject(req.url, ["case_id", "child_id"]));
  if (!query.success) return fail(400, "Invalid request", fieldErrors(query.error));
  const { case_id: caseId, child_id: childId } = query.data;
  if (caseId && !(await canUseCase(who, caseId))) return fail(404, MESSAGING_ERRORS.caseNotFound);
  if (childId && who.role === "guardian" && !(await getActiveGuardianLink(childId, who.user.id))) {
    return fail(404, MESSAGING_ERRORS.childNotFound);
  }
  const rows = await listThreads(who.user.id, { caseId, childId });
  return ok({
    threads: rows.map((r) => ({
      id: r.id,
      subject: r.subject,
      org_name: r.org_name,
      last_message_at: r.last_message_at,
      unread: r.unread,
      case_id: r.case_id,
      child_id: r.child_id,
      child_name: r.child_name,
      ...(who.role === "guardian" ? {} : { case_label: r.case_label }),
      archived_at: r.archived_at,
      created_at: r.created_at,
    })),
  });
}

// 027 FR-2: start a conversation about one case with its first message. Same client_id again -> 200 + the
// existing thread and message.
export async function POST(req: Request) {
  const who = await requireMessagingUser();
  if (who instanceof Response) return who;
  const parsed = await parseJson(req, ThreadCreateSchema);
  if ("response" in parsed) return parsed.response;
  if (!(await canUseCase(who, parsed.data.case_id))) return fail(404, MESSAGING_ERRORS.caseNotFound);
  const result = await createThread(who.user.id, parsed.data);
  if (!result.ok) return fail(result.status, result.error);
  return ok({ thread: result.data.thread, message: result.data.message }, result.data.created ? 201 : 200);
}
