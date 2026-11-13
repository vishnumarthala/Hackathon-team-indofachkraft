import { auditActorOf, AuditWriteError, auditFailure } from "@/lib/audit";
import { requireProviderApi } from "@/lib/authz";
import { MarkAllSchema, markAttendance, toAttendanceErrorCode } from "@/lib/booking/attendance";
import { runFeeJobsSoon } from "@/lib/fees/jobs";
import { ok, parseJson } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 044 FR-3 `Mark all remaining present`: each id is marked present on its own (same checks and audit as one tap).
// Sessions that are already marked, not started yet or not the caller's are skipped with their code; nothing is
// corrected in bulk (corrections need a reason).
export async function POST(req: Request) {
  const gate = await requireProviderApi();
  if ("response" in gate) return gate.response;
  const parsed = await parseJson(req, MarkAllSchema);
  if ("response" in parsed) return parsed.response;

  const actor = { ...auditActorOf(gate.actor.user, gate.actor.role), actorUserId: gate.actor.user.id };
  const marked: { appointment_id: string; billable: boolean | null }[] = [];
  const skipped: { appointment_id: string; code: string }[] = [];
  for (const id of [...new Set(parsed.data.appointment_ids)]) {
    try {
      const r = await markAttendance(id, actor, "present", null);
      if (r.result === "marked") marked.push({ appointment_id: id, billable: r.billable });
      else skipped.push({ appointment_id: id, code: "already_marked" });
    } catch (err) {
      if (err instanceof AuditWriteError) return auditFailure(err);
      const code = toAttendanceErrorCode(err);
      if (!code) throw err;
      skipped.push({ appointment_id: id, code: code === "reason_required" ? "already_marked" : code });
    }
  }
  // 045: charges from billable sessions -> balance payment links right after the response.
  if (marked.length) runFeeJobsSoon();
  return ok({ marked, skipped });
}
