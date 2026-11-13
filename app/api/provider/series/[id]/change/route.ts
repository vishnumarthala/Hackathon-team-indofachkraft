import { audit } from "@/lib/audit";
import { requireProviderApi } from "@/lib/authz";
import { isUuid } from "@/lib/cases/validation";
import { changeSeriesFrom, getManageableSeries, SeriesChangeSchema, withSeriesErrors } from "@/lib/booking/series";
import { fail, ok, parseJson } from "@/lib/http";
import { drainSoon } from "@/lib/notify/outbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 043 FR-5 "This and future sessions": the series ends the day before `from`, its future untouched sessions are
// cancelled (series_changed) and a new series continues from `from`. One message to the family.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireProviderApi();
  if ("response" in gate) return gate.response;
  const series = isUuid(id) ? await getManageableSeries(id, gate.actor.user.id) : null;
  if (!series) return fail(404, "Not found");
  const parsed = await parseJson(req, SeriesChangeSchema);
  if ("response" in parsed) return parsed.response;

  const result = await withSeriesErrors(() => changeSeriesFrom(id, gate.actor.user.id, parsed.data));
  if ("response" in result) return result.response;
  drainSoon();
  await audit({
    actorUserId: gate.actor.user.id,
    caseId: series.case_id,
    orgId: series.org_id,
    childId: series.child_id,
    action: "series.changed",
    entity: "appointment_series",
    entityId: id,
    details: { from: parsed.data.from, new_series_id: result.data.series_id, cancelled: result.data.cancelled },
  });
  return ok(result.data, 201);
}
