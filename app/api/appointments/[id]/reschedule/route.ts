import { audit } from "@/lib/audit";
import { requireAppointmentActor } from "@/lib/booking/authz";
import { withBookingErrors } from "@/lib/booking/errors";
import { RescheduleSchema } from "@/lib/booking/schemas";
import { getAppointment, rescheduleAppointment } from "@/lib/booking/store";
import { ok, parseJson } from "@/lib/http";
import { drainSoon } from "@/lib/notify/outbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// FR-4 reschedule { start }: one transaction creates the new confirmed appointment (same snapshot, rescheduled_from)
// and cancels the old one; 409 slot taken leaves the old appointment unchanged.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await requireAppointmentActor(id);
  if (actor instanceof Response) return actor;
  const parsed = await parseJson(req, RescheduleSchema);
  if ("response" in parsed) return parsed.response;

  const result = await withBookingErrors(() => rescheduleAppointment(id, parsed.data.start, actor.userId, actor.kind));
  if ("response" in result) return result.response;
  if (result.data.event_id) drainSoon([String(result.data.event_id)]);

  const appointment = await getAppointment(result.data.appointment_id);
  await audit({
    actorUserId: actor.userId,
    actorRole: actor.role,
    childId: appointment?.child_id ?? null,
    orgId: appointment?.org_id ?? null,
    action: "appointment.rescheduled",
    entity: "appointment",
    entityId: result.data.appointment_id,
    details: { rescheduled_from: id, by: actor.kind },
  });
  return ok({ appointment, rescheduled_from: id });
}
