// Booking data access (ticket 030). Server-only: uses the shared Postgres pool (lib/pg.ts). Every caller must have
// passed its gate (requireGuardian / provider context / public profile checks); the SQL state machine re-checks
// ownership, so a wrong owner always ends as `not_found` (404).
import { env } from "@/lib/env";
import { pg, type Queryable } from "@/lib/pg";
import { BookingError } from "./errors";
import { assertCanPublishPaid } from "@/lib/payouts/store";
import { defaultIntakeKind } from "./intake-defaults";
import type { HoldInput, OverrideCreate, RuleCreate, ServiceCreate, ServiceUpdate } from "./schemas";
import { generateSlots, HORIZON_DAYS, type BusyRange, type RuleMode, type ServiceMode, type Slot, type SlotOverride, type SlotRule } from "./slots";
import { addDays, todayIn } from "./time";

export type ServiceRow = {
  id: string;
  provider_profile_id: string;
  org_id: string;
  location_id: string | null;
  name: string;
  mode: ServiceMode;
  duration_min: number;
  fee_inr: number;
  payment_mode: "online" | "at_clinic" | "free";
  buffer_min: number;
  intake_kind: "child_dev" | "generic" | "none";
  active: boolean;
  location_name: string | null;
  location_address: string | null;
  /** The location's time zone, or the provider profile's for video services. */
  time_zone: string;
  /** 046 FR-2: free, or the organisation's payout account is active. Paid services of other organisations are hidden
   * from booking. */
  payouts_ready: boolean;
};

export type ServiceSnapshot = {
  name: string;
  duration_min: number;
  mode: ServiceMode;
  fee_inr: number;
  payment_mode: "online" | "at_clinic" | "free";
  buffer_min?: number;
  intake_kind?: string;
  provider_name?: string;
  time_zone?: string;
  location: { id?: string; name: string; address: string; lat: number | null; lng: number | null; time_zone?: string } | null;
};

export type AppointmentStatus = "held" | "pending_payment" | "confirmed" | "cancelled" | "expired" | "completed" | "no_show";

export type AppointmentView = {
  id: string;
  provider_profile_id: string;
  org_id: string;
  service_id: string | null;
  service_snapshot: ServiceSnapshot;
  status: AppointmentStatus;
  starts_at: string;
  ends_at: string;
  hold_expires_at: string | null;
  child_id: string | null;
  child_name: string | null;
  child_date_of_birth: string | null;
  guardian_user_id: string | null;
  cancelled_by: "guardian" | "provider" | "system" | null;
  cancel_reason: string | null;
  rescheduled_from: string | null;
  origin_appointment_id: string | null;
  provider_name: string;
  provider_slug: string;
  provider_time_zone: string;
  created_at: string;
  /** 042 FR-2a: booked on a demo profile (free, no payment, no Meet, in-app notifications only). */
  is_demo: boolean;
  /** 043: a session of a weekly series (null for one-off bookings), and the series date it stands for. */
  series_id: string | null;
  series_occurrence_date: string | null;
  /** 044: the register's outcome (null = not marked) and whether it is charged (045/046). */
  attendance: "present" | "absent" | "late_cancel_family" | "cancelled_centre" | null;
  billable: boolean | null;
};

export type BookableProfile = {
  id: string;
  slug: string;
  display_name: string;
  provider_type: string;
  time_zone: string;
  is_synthetic: boolean;
};

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const isoOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : iso(v));

function toView(row: Record<string, unknown>): AppointmentView {
  return {
    ...(row as unknown as AppointmentView),
    starts_at: iso(row.starts_at),
    ends_at: iso(row.ends_at),
    hold_expires_at: isoOrNull(row.hold_expires_at),
    created_at: iso(row.created_at),
    child_date_of_birth: row.child_date_of_birth ? String(row.child_date_of_birth).slice(0, 10) : null,
  };
}

const APPOINTMENT_SELECT = (sql: Queryable) => sql`
  select a.id, a.provider_profile_id, a.org_id, a.service_id, a.service_snapshot, a.status,
         lower(a.slot) as starts_at, upper(a.slot) as ends_at, a.hold_expires_at, a.child_id,
         c.display_name as child_name, c.date_of_birth::text as child_date_of_birth, a.guardian_user_id,
         a.cancelled_by, a.cancel_reason, a.rescheduled_from, a.origin_appointment_id,
         p.display_name as provider_name, p.slug as provider_slug, p.time_zone as provider_time_zone, a.created_at,
         a.is_demo, a.series_id, a.series_occurrence_date::text as series_occurrence_date, a.attendance, a.billable
  from public.appointments a
  join public.provider_profiles p on p.id = a.provider_profile_id
  left join public.children c on c.id = a.child_id and c.deleted_at is null`;

// ---------- public: profile, services, slots ----------

/** Verified + listed profile (demo profiles only while SHOW_SYNTHETIC_LISTINGS). Null for everything else. */
export async function getBookableProfile(profileId: string): Promise<BookableProfile | null> {
  const sql = await pg();
  const rows = await sql<BookableProfile[]>`
    select id, slug, display_name, provider_type, time_zone, is_synthetic from public.provider_profiles
    where id = ${profileId} and verification_status = 'verified' and listed
      ${env.SHOW_SYNTHETIC_LISTINGS ? sql`` : sql`and not is_synthetic`}`;
  return rows[0] ?? null;
}

const SERVICE_SELECT = (sql: Queryable) => sql`
  select s.id, s.provider_profile_id, s.org_id, s.location_id, s.name, s.mode, s.duration_min, s.fee_inr, s.payment_mode,
         s.buffer_min, s.intake_kind, s.active, l.name as location_name,
         case when l.id is null then null else concat_ws(', ', l.address_line1, l.address_line2, l.locality, l.city || ' ' || l.pincode) end
           as location_address,
         coalesce(l.time_zone, p.time_zone) as time_zone,
         (s.payment_mode <> 'online' or s.fee_inr = 0 or public.payouts_org_can_charge(s.org_id, ${env.DEMO_MODE})) as payouts_ready
  from public.services s
  join public.provider_profiles p on p.id = s.provider_profile_id
  left join public.practice_locations l on l.id = s.location_id`;

export async function listServices(profileId: string, opts: { activeOnly?: boolean } = {}): Promise<ServiceRow[]> {
  const sql = await pg();
  return sql<ServiceRow[]>`
    ${SERVICE_SELECT(sql)}
    where s.provider_profile_id = ${profileId}
      ${opts.activeOnly ? sql`and s.active and (s.payment_mode <> 'online' or s.fee_inr = 0 or public.payouts_org_can_charge(s.org_id, ${env.DEMO_MODE}))` : sql``}
    order by s.active desc, s.name, s.duration_min`;
}

export async function getService(serviceId: string): Promise<ServiceRow | null> {
  const sql = await pg();
  const rows = await sql<ServiceRow[]>`${SERVICE_SELECT(sql)} where s.id = ${serviceId}`;
  return rows[0] ?? null;
}

/** Loads rules, overrides and blocking appointments around [from, from + days) and runs the pure generator. */
export async function getSlots(service: ServiceRow, opts: { from?: string; days: number; now?: Date }): Promise<{ from: string; slots: Slot[] }> {
  const sql = await pg();
  const now = opts.now ?? new Date();
  const today = todayIn(service.time_zone, now);
  let from = opts.from ?? today;
  if (from < addDays(today, -1)) from = addDays(today, -1);
  const lastAllowed = addDays(today, HORIZON_DAYS);
  if (from > lastAllowed) return { from, slots: [] };
  const days = Math.min(opts.days, 14);
  const to = addDays(from, days);

  const [{ profile_tz }] = await sql<{ profile_tz: string }[]>`
    select time_zone as profile_tz from public.provider_profiles where id = ${service.provider_profile_id}`;
  const rules = await sql<(Omit<SlotRule, "valid_from" | "valid_to"> & { valid_from: string; valid_to: string | null })[]>`
    select r.weekday, r.start_time::text as start_time, r.end_time::text as end_time, r.mode, r.location_id,
           r.valid_from::text as valid_from, r.valid_to::text as valid_to, coalesce(l.time_zone, ${profile_tz}) as time_zone
    from public.availability_rules r left join public.practice_locations l on l.id = r.location_id
    where r.provider_profile_id = ${service.provider_profile_id}`;
  const overrides = await sql<SlotOverride[]>`
    select o.date::text as date, o.kind, o.start_time::text as start_time, o.end_time::text as end_time, o.mode, o.location_id,
           coalesce(l.time_zone, ${profile_tz}) as time_zone
    from public.availability_overrides o left join public.practice_locations l on l.id = o.location_id
    where o.provider_profile_id = ${service.provider_profile_id}
      and o.date between ${addDays(from, -1)}::date and ${addDays(to, 1)}::date`;
  const busyRows = await sql<{ start: Date; end: Date; buffer_min: number }[]>`
    select lower(slot) as start, upper(slot) as "end", coalesce((service_snapshot ->> 'buffer_min')::int, 0) as buffer_min
    from public.appointments
    where provider_profile_id = ${service.provider_profile_id}
      and (status = 'confirmed' or (status in ('held', 'pending_payment') and hold_expires_at > now()))
      and slot && tstzrange(${addDays(from, -2)}::date::timestamptz, ${addDays(to, 2)}::date::timestamptz, '[)')`;
  const busy: BusyRange[] = busyRows.map((b) => ({ start: iso(b.start), end: iso(b.end), buffer_min: b.buffer_min }));

  const slots = generateSlots({
    service: { mode: service.mode, location_id: service.location_id, duration_min: service.duration_min, buffer_min: service.buffer_min },
    rules: rules as SlotRule[],
    overrides,
    busy,
    from,
    days,
    now,
  });
  return { from, slots };
}

// ---------- state machine (FR-3) ----------

export type HoldOwner = { userId: string } | { sessionHash: string };

export type HoldResult = { appointment_id: string; hold_expires_at: string | null; status: AppointmentStatus; replay: boolean };

export async function holdSlot(input: HoldInput, owner: HoldOwner, sql?: Queryable): Promise<HoldResult> {
  const db = sql ?? (await pg());
  const [row] = await db<{ r: HoldResult }[]>`
    select public.booking_hold(${input.service_id}::uuid, ${input.start}::timestamptz,
      ${"userId" in owner ? owner.userId : null}::uuid, ${"sessionHash" in owner ? owner.sessionHash : null},
      ${input.idempotency_key}) as r`;
  return row.r;
}

export type ConfirmResult = { appointment_id: string; status: AppointmentStatus; event_id: string | null };

/** Attach (anonymous session or the guardian's own hold) + confirm, in one transaction. */
export async function confirmHold(input: { appointmentId: string; guardianId: string; childId: string; sessionHash: string | null }): Promise<ConfirmResult> {
  const sql = await pg();
  return sql.begin(async (tx) => {
    await tx`select public.booking_attach(${input.appointmentId}::uuid, ${input.guardianId}::uuid, ${input.sessionHash},
      ${input.guardianId}::uuid, ${input.childId}::uuid)`;
    const [row] = await tx<{ r: ConfirmResult }[]>`select public.booking_confirm(${input.appointmentId}::uuid, ${input.guardianId}::uuid) as r`;
    return row.r;
  }) as Promise<ConfirmResult>;
}

export type ActorKind = "guardian" | "provider" | "system";

export async function cancelAppointment(id: string, actor: string | null, kind: ActorKind, reason?: string | null) {
  const sql = await pg();
  const [row] = await sql<{ r: { appointment_id: string; status: AppointmentStatus; event_id: string | null } }[]>`
    select public.booking_cancel(${id}::uuid, ${actor}::uuid, ${kind}, ${reason ?? null}) as r`;
  return row.r;
}

export async function rescheduleAppointment(id: string, start: string, actor: string, kind: "guardian" | "provider") {
  const sql = await pg();
  const [row] = await sql<{ r: { appointment_id: string; rescheduled_from: string; status: AppointmentStatus; event_id: string | null } }[]>`
    select public.booking_reschedule(${id}::uuid, ${start}::timestamptz, ${actor}::uuid, ${kind}) as r`;
  return row.r;
}

export async function completeAppointment(id: string, provider: string, status: "completed" | "no_show") {
  const sql = await pg();
  return sql.begin(async (tx) => {
    const [row] = await tx<{ r: { appointment_id: string; status: AppointmentStatus } }[]>`
      select public.booking_complete(${id}::uuid, ${provider}::uuid, ${status}) as r`;
    // 044: the trigger `appointments_attendance_sync` filled attendance + billable in the same update; record who.
    await tx`update public.appointments set attendance_marked_by = ${provider}::uuid where id = ${id}::uuid and attendance_marked_by is null`;
    return row.r;
  }) as Promise<{ appointment_id: string; status: AppointmentStatus }>;
}

/** FR-5 worker: expire held / pending_payment rows whose hold passed. */
export async function expireStaleHolds(limit = 1000): Promise<number> {
  const sql = await pg();
  const [row] = await sql<{ n: number }[]>`select public.booking_expire_stale(null, ${limit}) as n`;
  return row.n;
}

// ---------- reads ----------

export async function getAppointment(id: string): Promise<AppointmentView | null> {
  const sql = await pg();
  const rows = await sql`${APPOINTMENT_SELECT(sql)} where a.id = ${id}`;
  return rows[0] ? toView(rows[0]) : null;
}

/** A hold visible to its owner (signed-in user or anonymous session). Others get null. */
export async function getOwnedHold(id: string, owner: { userId: string | null; sessionHash: string | null }): Promise<AppointmentView | null> {
  const sql = await pg();
  const rows = await sql`
    ${APPOINTMENT_SELECT(sql)}
    where a.id = ${id}
      and ((${owner.userId}::uuid is not null and (a.hold_owner_user_id = ${owner.userId}::uuid or a.guardian_user_id = ${owner.userId}::uuid))
        or (a.hold_owner_user_id is null and ${owner.sessionHash}::text is not null and a.hold_owner_session = ${owner.sessionHash}::text))`;
  return rows[0] ? toView(rows[0]) : null;
}

/** The guardian's own bookings (FR-7 /family/appointments). Holds in progress and expired holds are not listed. */
export async function listGuardianAppointments(userId: string): Promise<AppointmentView[]> {
  const sql = await pg();
  const rows = await sql`
    ${APPOINTMENT_SELECT(sql)}
    where a.guardian_user_id = ${userId}
      and (a.status not in ('held', 'expired')
           -- 031: an expired booking whose late payment is being refunded stays visible (payment status).
           or exists (select 1 from public.payments p where p.appointment_id = a.id and p.status in ('captured', 'refund_pending', 'refunded')))
    order by lower(a.slot) desc
    limit 200`;
  return rows.map(toView);
}

export type AgendaItem = AppointmentView & { outside_availability: boolean };

/** Provider agenda (FR-8): every appointment of the profile in [from, to). Future confirmed appointments that no
 * longer fit the published availability (e.g. a blocked date) are flagged. */
export async function listAgenda(profileId: string, from: Date, to: Date): Promise<AgendaItem[]> {
  const sql = await pg();
  const rows = await sql`
    select x.*, case when x.status <> 'confirmed' or x.ends_at <= now() then false
      -- 043: series sessions need not sit on the booking grid, only inside the hours and off blocked dates.
      when x.series_id is not null then coalesce(public.series_slot_problem(
        x.provider_profile_id, x.service_snapshot ->> 'mode', nullif(x.service_snapshot -> 'location' ->> 'id', '')::uuid,
        (x.service_snapshot ->> 'duration_min')::int, 0, x.starts_at, x.id) in ('blocked_date', 'outside_hours'), false)
      else not public.booking_slot_valid(
        x.provider_profile_id, x.service_snapshot ->> 'mode', nullif(x.service_snapshot -> 'location' ->> 'id', '')::uuid,
        (x.service_snapshot ->> 'duration_min')::int, x.starts_at) end as outside_availability
    from (${APPOINTMENT_SELECT(sql)}
          where a.provider_profile_id = ${profileId} and a.status <> 'expired'
            and not (a.status = 'cancelled' and a.cancel_reason = 'hold_released')
            and a.slot && tstzrange(${from}::timestamptz, ${to}::timestamptz, '[)')) x
    order by x.starts_at, x.created_at`;
  return rows.map((r) => ({ ...toView(r), outside_availability: Boolean(r.outside_availability) }));
}

// ---------- provider management (FR-8) ----------

export type ProviderContext = {
  profile: { id: string; display_name: string; time_zone: string; verification_status: string; listed: boolean; slug: string; provider_type: string };
  /** Organisations the provider is an active member of. */
  orgs: { id: string; name: string }[];
  /** Locations linked to the profile (028 provider_locations) in those organisations. */
  locations: { id: string; org_id: string; name: string; time_zone: string; address: string }[];
};

export async function getProviderContext(userId: string): Promise<ProviderContext | null> {
  const sql = await pg();
  const [profile] = await sql<ProviderContext["profile"][]>`
    select id, display_name, time_zone, verification_status, listed, slug, provider_type from public.provider_profiles where user_id = ${userId}`;
  if (!profile) return null;
  const orgs = await sql<{ id: string; name: string }[]>`
    select o.id, coalesce(o.public_name, o.name) as name from public.org_members m join public.organizations o on o.id = m.org_id
    where m.user_id = ${userId} and m.status = 'active' order by 2`;
  const orgIds = orgs.map((o) => o.id);
  const locations = orgIds.length
    ? await sql<ProviderContext["locations"]>`
        select l.id, l.org_id, l.name, l.time_zone,
               concat_ws(', ', l.address_line1, l.address_line2, l.locality, l.city || ' ' || l.pincode) as address
        from public.provider_locations pl join public.practice_locations l on l.id = pl.location_id
        where pl.provider_profile_id = ${profile.id} and l.org_id in ${sql(orgIds)} order by l.name`
    : [];
  return { profile, orgs, locations };
}

/** Org for a new service/rule: the location's org, else the requested org, else the provider's only/first org. */
function resolveOrg(ctx: ProviderContext, locationId: string | undefined, orgId: string | undefined): string {
  if (locationId) {
    const loc = ctx.locations.find((l) => l.id === locationId);
    if (!loc) throw new BookingError("service_not_found");
    return loc.org_id;
  }
  if (orgId) {
    if (!ctx.orgs.some((o) => o.id === orgId)) throw new BookingError("service_not_found");
    return orgId;
  }
  if (ctx.orgs.length === 0) throw new BookingError("service_not_found");
  return ctx.orgs[0].id;
}

export class ProviderInputError extends Error {
  constructor(readonly field: string, message: string) {
    super(message);
  }
}

function orgOrInputError(ctx: ProviderContext, locationId: string | undefined, orgId: string | undefined): string {
  try {
    return resolveOrg(ctx, locationId, orgId);
  } catch {
    throw new ProviderInputError(locationId ? "location_id" : "org_id", locationId ? "Choose one of your locations" : "Choose one of your organisations");
  }
}

/** 046 FR-2 / FR-8: a paid service goes live only with an active payout account and the accepted platform fee. */
async function assertPaidAllowed(orgId: string, service: { payment_mode: string; fee_inr: number; active: boolean }): Promise<void> {
  if (service.active && service.payment_mode === "online" && service.fee_inr > 0) await assertCanPublishPaid(orgId);
}

export async function createService(ctx: ProviderContext, input: ServiceCreate): Promise<ServiceRow> {
  const sql = await pg();
  const orgId = orgOrInputError(ctx, input.mode === "in_clinic" ? input.location_id : undefined, input.org_id);
  await assertPaidAllowed(orgId, { payment_mode: input.payment_mode, fee_inr: input.fee_inr, active: true });
  const [row] = await sql<{ id: string }[]>`
    insert into public.services (provider_profile_id, org_id, location_id, name, mode, duration_min, fee_inr, payment_mode, buffer_min, intake_kind)
    values (${ctx.profile.id}, ${orgId}, ${input.mode === "in_clinic" ? (input.location_id ?? null) : null}, ${input.name}, ${input.mode},
            ${input.duration_min}, ${input.fee_inr}, ${input.payment_mode}, ${input.buffer_min},
            ${input.intake_kind ?? defaultIntakeKind(ctx.profile.provider_type)})
    returning id`;
  return (await getService(row.id)) as ServiceRow;
}

export async function updateService(ctx: ProviderContext, serviceId: string, patch: ServiceUpdate): Promise<ServiceRow | null> {
  const sql = await pg();
  const existing = await getService(serviceId);
  if (!existing || existing.provider_profile_id !== ctx.profile.id) return null;
  const next = { ...existing, ...patch };
  if (next.payment_mode === "free" && next.fee_inr !== 0) throw new ProviderInputError("fee_inr", "A free service has no fee");
  // 045 FR-2: an old `at_clinic` service cannot be saved as such any more (the migration moved them all).
  if (next.payment_mode === "at_clinic") throw new ProviderInputError("payment_mode", "Choose online or free (pay at clinic is retired)");
  if (next.payment_mode === "online" && !(next.fee_inr > 0)) throw new ProviderInputError("fee_inr", "Enter the fee");
  // Going live as a paid service (new, switched to online, or turned on again) needs payout setup (046 FR-2).
  const wasLivePaid = existing.active && existing.payment_mode === "online" && existing.fee_inr > 0;
  if (!wasLivePaid) await assertPaidAllowed(existing.org_id, next);
  await sql`
    update public.services set name = ${next.name}, duration_min = ${next.duration_min}, fee_inr = ${next.fee_inr},
      payment_mode = ${next.payment_mode}, buffer_min = ${next.buffer_min}, intake_kind = ${next.intake_kind}, active = ${next.active},
      updated_at = now()
    where id = ${serviceId} and provider_profile_id = ${ctx.profile.id}`;
  return getService(serviceId);
}

/** 045 FR-2: show the one-time "Pay at clinic is retired" notice (some of the profile's services were moved to online
 * payment by the migration and the provider has not dismissed it yet). */
export async function atClinicNoticeDue(profileId: string): Promise<boolean> {
  const sql = await pg();
  const [row] = await sql<{ due: boolean }[]>`
    select (p.at_clinic_notice_dismissed_at is null
            and exists (select 1 from public.services s where s.provider_profile_id = p.id and s.migrated_from_at_clinic_at is not null)) as due
    from public.provider_profiles p where p.id = ${profileId}`;
  return Boolean(row?.due);
}

export type RuleRow = {
  id: string;
  org_id: string;
  location_id: string | null;
  location_name: string | null;
  weekday: number;
  start_time: string;
  end_time: string;
  mode: RuleMode;
  valid_from: string;
  valid_to: string | null;
};

export async function listRules(profileId: string): Promise<RuleRow[]> {
  const sql = await pg();
  return sql<RuleRow[]>`
    select r.id, r.org_id, r.location_id, l.name as location_name, r.weekday, to_char(r.start_time, 'HH24:MI') as start_time,
           case when r.end_time = '24:00'::time then '24:00' else to_char(r.end_time, 'HH24:MI') end as end_time, r.mode,
           r.valid_from::text as valid_from, r.valid_to::text as valid_to
    from public.availability_rules r left join public.practice_locations l on l.id = r.location_id
    where r.provider_profile_id = ${profileId} order by r.weekday, r.start_time`;
}

export async function createRule(ctx: ProviderContext, input: RuleCreate): Promise<RuleRow> {
  const sql = await pg();
  const orgId = orgOrInputError(ctx, input.location_id, input.org_id);
  const [row] = await sql<{ id: string }[]>`
    insert into public.availability_rules (provider_profile_id, org_id, location_id, weekday, start_time, end_time, mode, valid_from, valid_to)
    values (${ctx.profile.id}, ${orgId}, ${input.location_id ?? null}, ${input.weekday}, ${input.start_time}::time, ${input.end_time}::time,
            ${input.mode}, ${input.valid_from ?? todayIn(ctx.profile.time_zone)}::date, ${input.valid_to ?? null}::date)
    returning id`;
  return (await listRules(ctx.profile.id)).find((r) => r.id === row.id) as RuleRow;
}

export async function deleteRule(profileId: string, ruleId: string): Promise<boolean> {
  const sql = await pg();
  const result = await sql`delete from public.availability_rules where id = ${ruleId} and provider_profile_id = ${profileId}`;
  return result.count > 0;
}

export type OverrideRow = {
  id: string;
  date: string;
  kind: "unavailable" | "extra";
  start_time: string | null;
  end_time: string | null;
  mode: RuleMode | null;
  location_id: string | null;
  location_name: string | null;
  note: string | null;
};

export async function listOverrides(profileId: string, fromDate: string): Promise<OverrideRow[]> {
  const sql = await pg();
  return sql<OverrideRow[]>`
    select o.id, o.date::text as date, o.kind, to_char(o.start_time, 'HH24:MI') as start_time,
           case when o.end_time = '24:00'::time then '24:00' else to_char(o.end_time, 'HH24:MI') end as end_time,
           o.mode, o.location_id, l.name as location_name, o.note
    from public.availability_overrides o left join public.practice_locations l on l.id = o.location_id
    where o.provider_profile_id = ${profileId} and o.date >= ${fromDate}::date order by o.date, o.start_time nulls first`;
}

export async function createOverride(ctx: ProviderContext, input: OverrideCreate): Promise<OverrideRow> {
  const sql = await pg();
  if (input.location_id && !ctx.locations.some((l) => l.id === input.location_id)) {
    throw new ProviderInputError("location_id", "Choose one of your locations");
  }
  const [row] = await sql<{ id: string }[]>`
    insert into public.availability_overrides (provider_profile_id, date, kind, start_time, end_time, mode, location_id, note)
    values (${ctx.profile.id}, ${input.date}::date, ${input.kind}, ${input.start_time ?? null}::time, ${input.end_time ?? null}::time,
            ${input.mode ?? null}, ${input.location_id ?? null}, ${input.note || null})
    returning id`;
  return (await listOverrides(ctx.profile.id, input.date)).find((o) => o.id === row.id) as OverrideRow;
}

export async function deleteOverride(profileId: string, overrideId: string): Promise<boolean> {
  const sql = await pg();
  const result = await sql`delete from public.availability_overrides where id = ${overrideId} and provider_profile_id = ${profileId}`;
  return result.count > 0;
}

/** Can the user act for the provider side of this appointment (profile owner, or org owner/admin)? */
export async function isAppointmentProvider(appointmentId: string, userId: string): Promise<boolean> {
  const sql = await pg();
  const [row] = await sql<{ ok: boolean }[]>`
    select coalesce((select public.booking_is_provider(a.provider_profile_id, a.org_id, ${userId}::uuid)
                     from public.appointments a where a.id = ${appointmentId}), false) as ok`;
  return row.ok;
}
