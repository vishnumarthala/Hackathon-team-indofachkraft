import { audit } from "@/lib/audit";
import { requireProviderApi } from "@/lib/authz";
import { isUuid } from "@/lib/cases/validation";
import { getManageableSeries, pauseSeries, SeriesPauseSchema, withSeriesErrors } from "@/lib/booking/series";
import { fail, ok, parseJson } from "@/lib/http";
import { drainSoon } from "@/lib/notify/outbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 043 FR-5 Pause { from, to }: sessions in the range are cancelled (series_paused); past sessions never change.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireProviderApi();
  if ("response" in gate) return gate.response;
  const series = isUuid(id) ? await getManageableSeries(id, gate.actor.user.id) : null;
  if (!series) return fail(404, "Not found");
  const parsed = await parseJson(req, SeriesPauseSchema);
  if ("response" in parsed) return parsed.response;

  const result = await withSeriesErrors(() => pauseSeries(id, gate.actor.user.id, parsed.data.from, parsed.data.to));
  if ("response" in result) return result.response;
  drainSoon();
  await audit({
    actorUserId: gate.actor.user.id,
    caseId: series.case_id,
    orgId: series.org_id,
    childId: series.child_id,
    action: "series.paused",
    entity: "appointment_series",
    entityId: id,
    details: { from: parsed.data.from, to: parsed.data.to, cancelled: result.data.cancelled },
  });
  return ok(result.data);
}
