import { requireChildGuardian, requireGuardian } from "@/lib/authz";
import { deleteOwnLog, findOwnLog } from "@/lib/home-program";
import { MSG } from "@/lib/home-program/schema";
import { fail, ok } from "@/lib/http";
import { getTimeZone } from "@/lib/i18n/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 026 FR-5: a guardian removes one of their own logs of the current week -> 200. Other guardians' logs, missing ids
// and children the guardian is no longer linked to -> 404; logs from an earlier week -> 409.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireGuardian();
  if (session instanceof Response) return session;
  const { id } = await params;
  const log = await findOwnLog(id, session.user.id);
  if (!log) return fail(404, MSG.logNotFound);
  const access = await requireChildGuardian(log.child_id, session);
  if (access instanceof Response) return fail(404, MSG.logNotFound);

  const result = await deleteOwnLog({ log, userId: session.user.id, timeZone: await getTimeZone() });
  if (!result.ok) return fail(result.status, result.error, result.details);
  return ok({ deleted: true });
}
