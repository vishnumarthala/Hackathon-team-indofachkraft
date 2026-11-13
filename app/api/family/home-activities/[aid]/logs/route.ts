import { requireGuardian } from "@/lib/authz";
import { todayIn } from "@/lib/home-program/adherence";
import { saveLog } from "@/lib/home-program";
import { requireGuardianActivity } from "@/lib/home-program/authz";
import { makeLogSchema } from "@/lib/home-program/schema";
import { ok, parseJson } from "@/lib/http";
import { getTimeZone } from "@/lib/i18n/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 026 FR-5 / NFR-1: `Done today` `{ done_on, difficulty, duration_min?, note? }` -> 201 { log }; the same activity and
// date again -> 200 updating the guardian's existing log (idempotent, offline-safe retries). `done_on` in the future
// or more than 14 days ago (guardian's time zone) -> 400. Activities not in the published snapshot -> 404.
export async function POST(req: Request, { params }: { params: Promise<{ aid: string }> }) {
  const session = await requireGuardian();
  if (session instanceof Response) return session;
  const { aid } = await params;
  const activity = await requireGuardianActivity(aid, session);
  if (activity instanceof Response) return activity;
  const parsed = await parseJson(req, makeLogSchema(todayIn(await getTimeZone())));
  if ("response" in parsed) return parsed.response;

  const result = await saveLog({ activityId: activity.activityId, userId: session.user.id, body: parsed.data });
  return ok({ log: result.log, created: result.created }, result.created ? 201 : 200);
}
