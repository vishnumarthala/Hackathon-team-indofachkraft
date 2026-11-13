import { requireChildGuardian, requireGuardian } from "@/lib/authz";
import { getGuardianHomePrograms, listOwnLogs } from "@/lib/home-program";
import { ok } from "@/lib/http";
import { getTimeZone } from "@/lib/i18n/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 026 FR-5: `This week` for a child: the published home programs (snapshot only, NFR-2) with this week's counts in the
// guardian's time zone, plus the guardian's own logs of this week.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireGuardian();
  if (session instanceof Response) return session;
  const { id } = await params;
  const access = await requireChildGuardian(id, session);
  if (access instanceof Response) return access;

  const programs = await getGuardianHomePrograms(access.child.id, { timeZone: await getTimeZone() });
  const ids = programs.flatMap((p) => p.activities.map((a) => a.id));
  const week = programs[0];
  const myLogs = week ? await listOwnLogs(session.user.id, ids, week.week_start, week.week_end) : [];
  return ok({ programs, my_logs: myLogs });
}
