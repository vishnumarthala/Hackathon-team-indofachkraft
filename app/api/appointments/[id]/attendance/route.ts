import { auditActorOf, AuditWriteError, auditFailure } from "@/lib/audit";
import { requireProviderApi } from "@/lib/authz";
import { AttendanceMarkSchema, attendanceErrorResponse, markAttendance, toAttendanceErrorCode } from "@/lib/booking/attendance";
import { isUuid } from "@/lib/cases/validation";
import { runFeeJobsSoon } from "@/lib/fees/jobs";
import { fail, ok, parseJson } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 044 FR-1 - FR-4: mark (or correct, with `reason`) one session's attendance. Provider side only: an active member of
// the appointment's organisation who is owner/admin or the session's therapist (checked again in SQL); everyone else
// 404. Present/absent before the start -> 409 `not_started`; a correction without a reason -> 422; a member changing a
// session older than 7 days -> 403. The same value twice -> 200 `unchanged` (no second event).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireProviderApi();
  if ("response" in gate) return gate.response;
  if (!isUuid(id)) return fail(404, "Appointment not found");
  const parsed = await parseJson(req, AttendanceMarkSchema);
  if ("response" in parsed) return parsed.response;

  const actor = { ...auditActorOf(gate.actor.user, gate.actor.role), actorUserId: gate.actor.user.id };
  try {
    const r = await markAttendance(id, actor, parsed.data.attendance, parsed.data.reason ?? null);
    // 045: a billable session may have added a charge -> the balance payment link follows right after the response.
    if (r.result !== "unchanged") runFeeJobsSoon();
    return ok({ result: r.result, appointment_id: r.appointment_id, attendance: r.to, status: r.to_status, billable: r.billable });
  } catch (err) {
    const code = toAttendanceErrorCode(err);
    if (code) return attendanceErrorResponse(code);
    if (err instanceof AuditWriteError) return auditFailure(err);
    throw err;
  }
}
