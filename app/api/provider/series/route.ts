import { audit } from "@/lib/audit";
import { getCaseAccessLevel, requireProviderApi } from "@/lib/authz";
import { createSeries, SeriesCreateSchema, withSeriesErrors } from "@/lib/booking/series";
import { fail, ok, parseJson } from "@/lib/http";
import { drainSoon } from "@/lib/notify/outbox";
import { pg } from "@/lib/pg";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 043 FR-2/FR-3: create a weekly series for the child of a case. Guardians -> 403; a case the caller cannot access
// (other org, not assigned, missing) -> 404; a therapist the caller may not manage (not owner/admin and not their own
// profile) -> 404. The SQL function re-checks everything, materializes 8 weeks and queues one summary message.
export async function POST(req: Request) {
  const gate = await requireProviderApi();
  if ("response" in gate) return gate.response;
  const parsed = await parseJson(req, SeriesCreateSchema);
  if ("response" in parsed) return parsed.response;
  const input = parsed.data;
  const userId = gate.actor.user.id;

  if (!(await getCaseAccessLevel(userId, input.case_id))) return fail(404, "Case not found");
  const sql = await pg();
  const [kase] = await sql<{ org_id: string; child_id: string }[]>`select org_id, child_id from public.cases where id = ${input.case_id}`;
  if (!kase) return fail(404, "Case not found");

  const result = await withSeriesErrors(() =>
    createSeries({
      actorUserId: userId,
      orgId: kase.org_id,
      caseId: input.case_id,
      childId: kase.child_id,
      profileId: input.provider_profile_id,
      serviceId: input.service_id,
      weekdays: input.weekdays,
      startTime: input.start_time,
      startsOn: input.starts_on,
      endsOn: input.ends_on ?? null,
      billingMode: input.billing_mode,
      guardian: input.notify_family ? "auto" : null,
    }),
  );
  if ("response" in result) return result.response;
  drainSoon();
  await audit({
    actorUserId: userId,
    caseId: input.case_id,
    orgId: kase.org_id,
    childId: kase.child_id,
    action: "series.created",
    entity: "appointment_series",
    entityId: result.data.series_id,
    details: { created: result.data.created, conflicts: result.data.conflicts.length, weekdays: input.weekdays, billing_mode: input.billing_mode },
  });
  return ok(result.data, 201);
}
