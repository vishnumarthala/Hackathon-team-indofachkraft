import { audit } from "@/lib/audit";
import { requireProviderApi } from "@/lib/authz";
import { isUuid } from "@/lib/cases/validation";
import { endSeries, getManageableSeries, SeriesEndSchema, withSeriesErrors } from "@/lib/booking/series";
import { fail, ok, parseJson } from "@/lib/http";
import { drainSoon } from "@/lib/notify/outbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 043 FR-5 End { ends_on? (default today) }: no sessions after that date; later ones are cancelled (series_ended).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireProviderApi();
  if ("response" in gate) return gate.response;
  const series = isUuid(id) ? await getManageableSeries(id, gate.actor.user.id) : null;
  if (!series) return fail(404, "Not found");
  const parsed = await parseJson(req, SeriesEndSchema);
  if ("response" in parsed) return parsed.response;

  const result = await withSeriesErrors(() => endSeries(id, gate.actor.user.id, parsed.data.ends_on));
  if ("response" in result) return result.response;
  drainSoon();
  await audit({
    actorUserId: gate.actor.user.id,
    caseId: series.case_id,
    orgId: series.org_id,
    childId: series.child_id,
    action: "series.ended",
    entity: "appointment_series",
    entityId: id,
    details: { ends_on: parsed.data.ends_on ?? null, cancelled: result.data.cancelled },
  });
  return ok(result.data);
}
