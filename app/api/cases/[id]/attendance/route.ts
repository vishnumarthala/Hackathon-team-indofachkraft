import { requireCaseAccess } from "@/lib/authz";
import { listCaseAttendance } from "@/lib/booking/attendance";
import { attendanceCsv, effectiveAttendance, isValidMonth, monthCounts, monthOf } from "@/lib/booking/attendance-display";
import { isUuid } from "@/lib/cases/validation";
import { fail, ok } from "@/lib/http";
import { getTimeZone } from "@/lib/i18n/server";
import { getCase } from "@/lib/queries/cases";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 044 FR-6: a child's attendance for one month (`?month=YYYY-MM`, default this month, viewer's time zone) as JSON, or
// `&format=csv` for staff. Case access (022) only; other tenants' and malformed ids -> 404.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return fail(404, "Case not found");
  const denied = await requireCaseAccess(id);
  if (denied) return denied;
  const kase = await getCase(id);
  if (!kase) return fail(404, "Case not found");

  const url = new URL(req.url);
  const timeZone = await getTimeZone();
  const monthParam = url.searchParams.get("month");
  if (monthParam !== null && !isValidMonth(monthParam)) return fail(400, "Invalid request", { month: "Use YYYY-MM" });
  const month = monthParam ?? monthOf(new Date(), timeZone);
  const rows = await listCaseAttendance({ id: kase.id, org_id: kase.org_id, child_id: kase.child_id ?? null }, month, timeZone);

  if (url.searchParams.get("format") === "csv") {
    const time = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    const csv = attendanceCsv(
      rows.map((r) => ({
        date: r.local_date,
        time: time.format(new Date(r.starts_at)),
        therapist: r.provider_name,
        service: r.service_name,
        attendance: effectiveAttendance(r),
        status: r.status,
        billable: r.billable,
        marked_at: r.marked_at,
      })),
    );
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="attendance-${month}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  }
  return ok({
    month,
    time_zone: timeZone,
    counts: monthCounts(rows),
    sessions: rows.map((r) => ({
      appointment_id: r.id,
      date: r.local_date,
      starts_at: r.starts_at,
      therapist: r.provider_name,
      service: r.service_name,
      status: r.status,
      attendance: effectiveAttendance(r),
      billable: r.billable,
    })),
  });
}
