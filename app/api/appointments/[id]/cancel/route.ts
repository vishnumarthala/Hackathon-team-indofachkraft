import { audit } from "@/lib/audit";
import { requireAppointmentActor } from "@/lib/booking/authz";
import { withBookingErrors } from "@/lib/booking/errors";
import { CancelSchema } from "@/lib/booking/schemas";
import { cancelAppointment, getAppointment } from "@/lib/booking/store";
import { ok, parseJson } from "@/lib/http";
import { drainSoon } from "@/lib/notify/outbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// FR-4 cancel { reason? }: the booking guardian (confirmed: up to 2 h before the start) or the provider side (any time
// before the start). Unsent reminders are cancelled; the other side is notified (appointment.cancelled).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await requireAppointmentActor(id);
  if (actor instanceof Response) return actor;
  const parsed = await parseJson(req, CancelSchema);
  if ("response" in parsed) return parsed.response;

  const result = await withBookingErrors(() => cancelAppointment(id, actor.userId, actor.kind, parsed.data.reason));
  if ("response" in result) return result.response;
  if (result.data.event_id) drainSoon([String(result.data.event_id)]);

  const appointment = await getAppointment(id);
  await audit({
    actorUserId: actor.userId,
    actorRole: actor.role,
    childId: appointment?.child_id ?? null,
    orgId: appointment?.org_id ?? null,
    action: "appointment.cancelled",
    entity: "appointment",
    entityId: id,
    details: { cancelled_by: actor.kind },
  });
  return ok({ appointment });
}
