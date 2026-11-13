// Ticket 031: notification recipients for payment topics (re-checked at fan-out, 032 rule).
import type { Queryable } from "@/lib/pg";

/** The guardian who booked the appointment, while the payment is still refunded. */
export async function refundedPaymentGuardian(sql: Queryable, paymentId: string): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`
    select g.id from public.payments p
    join public.appointments a on a.id = p.appointment_id
    join public.user_profiles g on g.id = a.guardian_user_id and g.role = 'guardian'
    where p.id = ${paymentId} and p.status = 'refunded'`;
  return rows.map((r) => r.id);
}
