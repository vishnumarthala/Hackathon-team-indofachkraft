// 037: recipients of the Meet notifications, re-checked at fan-out time (docs/notifications.md).
import type { Queryable } from "@/lib/pg";

/** `appointment.meet_ready`: the booking guardian and the profile's provider while the appointment is confirmed and
 * has a link. */
export async function meetReadyRecipients(sql: Queryable, appointmentId: string): Promise<string[]> {
  const rows = await sql<{ guardian: string | null; provider: string | null }[]>`
    select g.id as guardian, p.user_id as provider
    from public.appointments a
    join public.provider_profiles p on p.id = a.provider_profile_id
    left join public.user_profiles g on g.id = a.guardian_user_id and g.role = 'guardian'
    where a.id = ${appointmentId} and a.status = 'confirmed' and a.meet_status in ('created', 'manual') and a.meet_url is not null`;
  return rows.flatMap((r) => [r.guardian, r.provider].filter((id): id is string => Boolean(id)));
}

/** `appointment.meet_failed`: the profile's provider while the appointment is confirmed and still has no link. */
export async function meetFailedRecipients(sql: Queryable, appointmentId: string): Promise<string[]> {
  const rows = await sql<{ user_id: string }[]>`
    select p.user_id from public.appointments a join public.provider_profiles p on p.id = a.provider_profile_id
    where a.id = ${appointmentId} and a.status = 'confirmed' and a.meet_status = 'failed' and p.user_id is not null`;
  return rows.map((r) => r.user_id);
}

/** `google_calendar.reconnect_required`: the profile's provider while the connection is still expired. */
export async function reconnectRecipients(sql: Queryable, providerProfileId: string): Promise<string[]> {
  const rows = await sql<{ user_id: string }[]>`
    select p.user_id from public.provider_profiles p
    join public.provider_google_connections c on c.provider_profile_id = p.id and c.status = 'expired'
    where p.id = ${providerProfileId} and p.user_id is not null`;
  return rows.map((r) => r.user_id);
}
