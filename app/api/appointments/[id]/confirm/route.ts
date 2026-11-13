import { audit } from "@/lib/audit";
import { requireGuardian } from "@/lib/authz";
import { withBookingErrors } from "@/lib/booking/errors";
import { ConfirmSchema } from "@/lib/booking/schemas";
import { currentBookingSessionHash } from "@/lib/booking/session";
import { confirmHold, getAppointment } from "@/lib/booking/store";
import { isUuid } from "@/lib/cases/validation";
import { fail, ok, parseJson } from "@/lib/http";
import { drainSoon } from "@/lib/notify/outbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// FR-4 confirm { child_id }: attaches an anonymous hold (session cookie) or the guardian's own hold to the guardian
// and child, then confirms (free / at_clinic) or moves to pending_payment (online, 031) - one transaction.
// Anonymous 401; someone else's hold 404; child not linked 422; expired hold 410.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await requireGuardian();
  if (session instanceof Response) return session;
  if (!isUuid(id)) return fail(404, "Appointment not found");
  const parsed = await parseJson(req, ConfirmSchema);
  if ("response" in parsed) return parsed.response;

  // An anonymous hold made before sign-in is proven by the booking-session cookie.
  const sessionHash = await currentBookingSessionHash();
  const result = await withBookingErrors(() =>
    confirmHold({ appointmentId: id, guardianId: session.user.id, childId: parsed.data.child_id, sessionHash }),
  );
  if ("response" in result) return result.response;
  if (result.data.event_id) drainSoon([String(result.data.event_id)]);

  const appointment = await getAppointment(id);
  await audit({
    actorUserId: session.user.id,
    actorRole: "guardian",
    childId: parsed.data.child_id,
    orgId: appointment?.org_id ?? null,
    action: result.data.status === "confirmed" ? "appointment.confirmed" : "appointment.pending_payment",
    entity: "appointment",
    entityId: id,
  });
  return ok({ appointment });
}
