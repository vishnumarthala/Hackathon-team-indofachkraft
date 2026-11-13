import { getAuthenticatedUser } from "@/lib/auth";
import { appointmentIcs } from "@/lib/booking/calendar";
import { getAppointment, isAppointmentProvider } from "@/lib/booking/store";
import { isUuid } from "@/lib/cases/validation";
import { fail } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// FR-7 "Add to calendar": the booking guardian or the provider side; everyone else 404.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getAuthenticatedUser();
  if (!user) return fail(401, "Authentication required");
  if (!isUuid(id)) return fail(404, "Appointment not found");
  const appointment = await getAppointment(id);
  if (!appointment || !["confirmed", "pending_payment", "cancelled", "completed"].includes(appointment.status)) {
    return fail(404, "Appointment not found");
  }
  const isGuardian = appointment.guardian_user_id === user.id;
  if (!isGuardian && !(await isAppointmentProvider(id, user.id))) return fail(404, "Appointment not found");
  return new Response(appointmentIcs(appointment, isGuardian ? "/family/appointments" : "/dashboard/schedule"), {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="appointment-${id.slice(0, 8)}.ics"`,
      "Cache-Control": "private, no-store",
    },
  });
}
