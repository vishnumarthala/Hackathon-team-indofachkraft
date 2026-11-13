// 036: notification recipients for rating topics (re-checked at fan-out, 032 rule).
import type { Queryable } from "@/lib/pg";
import { RATE_WINDOW_DAYS } from "./rules";

/** The booking guardian, while the appointment is completed, unrated and still inside the 30-day window. */
export async function ratingPromptGuardian(sql: Queryable, appointmentId: string): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`
    select g.id from public.appointments a
    join public.user_profiles g on g.id = a.guardian_user_id and g.role = 'guardian'
    where a.id = ${appointmentId} and a.status = 'completed'
      and not exists (select 1 from public.ratings r where r.appointment_id = a.id)
      and public.appointment_completed_at(a.id) > now() - make_interval(days => ${RATE_WINDOW_DAYS})`;
  return rows.map((r) => r.id);
}
