import { audit } from "@/lib/audit";
import { requireProviderApi } from "@/lib/authz";
import { isUuid } from "@/lib/cases/validation";
import { ConflictResolveSchema, getManageableConflict, resolveConflict, withSeriesErrors } from "@/lib/booking/series";
import { fail, ok, parseJson } from "@/lib/http";
import { drainSoon } from "@/lib/notify/outbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 043 FR-6 Conflicts: { action: "skip" } (`Skip this date`) or { action: "reschedule", start } (`Pick another time`:
// a confirmed session at that time, checked against hours, blocked dates and other bookings). One family message.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireProviderApi();
  if ("response" in gate) return gate.response;
  const found = isUuid(id) ? await getManageableConflict(id, gate.actor.user.id) : null;
  if (!found) return fail(404, "Not found");
  const parsed = await parseJson(req, ConflictResolveSchema);
  if ("response" in parsed) return parsed.response;

  const result = await withSeriesErrors(() => resolveConflict(id, gate.actor.user.id, parsed.data));
  if ("response" in result) return result.response;
  drainSoon();
  await audit({
    actorUserId: gate.actor.user.id,
    caseId: found.series.case_id,
    orgId: found.series.org_id,
    childId: found.series.child_id,
    action: "series.conflict_resolved",
    entity: "series_conflict",
    entityId: id,
    details: { resolution: result.data.resolution, appointment_id: result.data.appointment_id ?? null },
  });
  return ok(result.data);
}
