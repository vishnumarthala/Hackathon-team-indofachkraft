// Ticket 052 FR-1/FR-2: the family home. `loadFamilyFacts` reads everything the home page shows for one guardian
// (one query per card type, no per-child queries: NFR-1); `pickNextStep` turns those facts into the single most
// important action (the priority table of FR-1). Scope (NFR-2): only children with an ACTIVE guardian link of this
// user; appointments only when this guardian booked them (as on /family/appointments); balances and package offers of
// the linked children; message threads through 027's `list_message_threads` (guardian-link gated).
import { addDays, todayIn } from "@/lib/booking/time";
import { mondayOf } from "@/lib/home-program/adherence";
import { intakeAttemptPath } from "@/lib/intake/attempt-token";
import { pg } from "@/lib/pg";

export type IntakeAttemptFact = { id: string; status: "issued" | "started" | "completed"; path: string | null };

export type VisitFact = {
  id: string;
  child_id: string;
  child_name: string;
  status: "confirmed" | "pending_payment";
  starts_at: string;
  ends_at: string;
  provider_profile_id: string;
  provider_name: string;
  service_name: string;
  mode: "in_clinic" | "video";
  location_name: string | null;
  location_address: string | null;
  lat: number | null;
  lng: number | null;
  /** The clinic's (video: the provider's) zone, for "clinic time" when it differs from the viewer's. */
  clinic_time_zone: string | null;
  series_id: string | null;
  is_demo: boolean;
  fee_inr: number;
  hold_expires_at: string | null;
  /** The service has a pre-visit AI intake call (035). */
  has_intake: boolean;
  /** `ai_intake_call` is currently allowed for the child (020). */
  intake_consent: boolean;
  /** The appointment's intake attempt (an expired, unfinished one counts as none). */
  attempt: IntakeAttemptFact | null;
  meet_url: string | null;
  meet_status: string | null;
};

export type HomeFact = {
  /** Active activities in the child's current guardian-visible home programs. */
  activities: number;
  logged_today: boolean;
  /** At least one activity is still short of its weekly target. */
  behind: boolean;
  logs_this_week: number;
  /** Consecutive days with at least one practice log, ending today (or yesterday while today is still open). */
  streak: number;
};

export type ChildFact = {
  id: string;
  name: string;
  date_of_birth: string | null;
  care_team: string[];
  home: HomeFact;
};

export type PaymentFact = {
  kind: "appointment" | "balance" | "package";
  child_id: string;
  child_name: string;
  amount_paise: number;
  org_name: string | null;
  href: string;
};

export type MessageFact = { thread_id: string; child_id: string; unread: number; from: string | null };

export type CareTeamUpdate = {
  kind: "plan" | "note" | "home_program" | "prescription";
  child_id: string;
  child_name: string;
  org_name: string;
  published_at: string;
  href: string;
};

export type FamilyFacts = {
  children: ChildFact[];
  /** Upcoming (not yet ended) confirmed visits and open payment holds of this guardian, soonest first. */
  visits: VisitFact[];
  payments: PaymentFact[];
  messages: { unread: number; latest: MessageFact | null };
  updates: CareTeamUpdate[];
  timeZone: string;
};

export type NextStep =
  | { rule: "add_child" }
  | { rule: "permission"; child_id: string; child_name: string; visit: VisitFact; href: string }
  | { rule: "intake"; child_id: string; child_name: string; visit: VisitFact; href: string; ready: boolean }
  | { rule: "pay"; payment: PaymentFact }
  | { rule: "visit"; visit: VisitFact; day: "today" | "tomorrow" | "now" }
  | { rule: "practice"; child_id: string; child_name: string; href: string }
  | { rule: "message"; thread_id: string; from: string | null; unread: number; href: string }
  | { rule: "all_set"; next_visit: VisitFact | null };

/** The FR-1 rules in priority order (tests walk this list). */
export const NEXT_STEP_RULES = ["add_child", "permission", "intake", "pay", "visit", "practice", "message", "all_set"] as const;

export const permissionHref = (childId: string) => `/family/children/${childId}#permissions`;
export const appointmentHref = (appointmentId: string) => `/family/appointments/${appointmentId}`;
export const paymentsHref = (childId: string) => `/family/children/${childId}/payments`;
export const homeProgramHref = (childId: string) => `/family/children/${childId}/home-program`;

/** An intake that still has to happen before the visit (035): the service has one and it is not completed. */
export function intakePending(v: VisitFact): boolean {
  return v.status === "confirmed" && v.has_intake && v.attempt?.status !== "completed";
}

/** Google Maps directions to an in-clinic visit (a plain link: no map script on family pages). Null for video. */
export function directionsUrl(v: Pick<VisitFact, "mode" | "lat" | "lng" | "location_name" | "location_address">): string | null {
  if (v.mode !== "in_clinic") return null;
  const destination =
    v.lat !== null && v.lng !== null ? `${v.lat},${v.lng}` : [v.location_name, v.location_address].filter(Boolean).join(", ");
  return destination ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}` : null;
}

/** Whether a visit is in progress, today or tomorrow in the viewer's zone (null = later). */
export function visitDay(v: Pick<VisitFact, "starts_at" | "ends_at">, timeZone: string, now: Date = new Date()): "now" | "today" | "tomorrow" | null {
  const start = Date.parse(v.starts_at);
  if (start <= now.getTime() && Date.parse(v.ends_at) > now.getTime()) return "now";
  const day = todayIn(timeZone, new Date(start));
  const today = todayIn(timeZone, now);
  if (day === today) return "today";
  if (day === addDays(today, 1)) return "tomorrow";
  return null;
}

const PAYMENT_ORDER: Record<PaymentFact["kind"], number> = { appointment: 0, balance: 1, package: 2 };

/** FR-1: the single most important action, in the priority order of the ticket. Pure. */
export function pickNextStep(facts: FamilyFacts, now: Date = new Date()): NextStep {
  if (facts.children.length === 0) return { rule: "add_child" };

  const confirmed = facts.visits.filter((v) => v.status === "confirmed");
  const pending = confirmed.filter(intakePending);

  const needsPermission = pending.find((v) => !v.intake_consent);
  if (needsPermission) {
    return { rule: "permission", child_id: needsPermission.child_id, child_name: needsPermission.child_name, visit: needsPermission, href: permissionHref(needsPermission.child_id) };
  }

  const intake = pending.find((v) => v.intake_consent);
  if (intake) {
    const ready = Boolean(intake.attempt?.path);
    return {
      rule: "intake",
      child_id: intake.child_id,
      child_name: intake.child_name,
      visit: intake,
      href: ready ? (intake.attempt?.path as string) : appointmentHref(intake.id),
      ready,
    };
  }

  if (facts.payments.length) {
    const payment = [...facts.payments].sort((a, b) => PAYMENT_ORDER[a.kind] - PAYMENT_ORDER[b.kind] || b.amount_paise - a.amount_paise)[0];
    return { rule: "pay", payment };
  }

  for (const v of confirmed) {
    const day = visitDay(v, facts.timeZone, now);
    if (day) return { rule: "visit", visit: v, day };
  }

  const practice = facts.children.find((c) => c.home.activities > 0 && !c.home.logged_today && c.home.behind);
  if (practice) return { rule: "practice", child_id: practice.id, child_name: practice.name, href: homeProgramHref(practice.id) };

  if (facts.messages.latest) {
    const m = facts.messages.latest;
    return { rule: "message", thread_id: m.thread_id, from: m.from, unread: facts.messages.unread, href: `/family/messages/${m.thread_id}` };
  }

  return { rule: "all_set", next_visit: confirmed[0] ?? null };
}

/** Consecutive days with a log, ending today (or yesterday when today has no log yet). `days` = YYYY-MM-DD set. */
export function practiceStreak(days: Iterable<string>, today: string): number {
  const set = new Set(days);
  let day = set.has(today) ? today : addDays(today, -1);
  let streak = 0;
  while (set.has(day)) {
    streak += 1;
    day = addDays(day, -1);
  }
  return streak;
}

// ---------------------------------------------------------------------------------------------------------------
// loader (server only)

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const isoOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : iso(v));
const num = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : Number(v));

type Snapshot = {
  name?: string;
  mode?: "in_clinic" | "video";
  fee_inr?: number;
  time_zone?: string;
  provider_name?: string;
  intake_kind?: string;
  location?: { name?: string; address?: string; lat?: number | null; lng?: number | null; time_zone?: string } | null;
};

const STREAK_LOOKBACK_DAYS = 60;
const MAX_VISITS = 50;
const MAX_UPDATES = 3;
/** The payments page offers a link from ₹1 (045). */
const MIN_BALANCE_PAISE = 100;

/** The guardian's actively linked, live children (oldest link first). */
export async function listLinkedChildren(userId: string): Promise<{ id: string; name: string; date_of_birth: string | null }[]> {
  const sql = await pg();
  const rows = await sql<{ id: string; name: string; date_of_birth: string | null }[]>`
    select c.id, c.display_name as name, c.date_of_birth::text as date_of_birth
    from public.guardian_links gl
    join public.children c on c.id = gl.child_id and c.deleted_at is null
    where gl.user_id = ${userId} and gl.status = 'active'
    order by gl.created_at, c.id`;
  return rows.map((r) => ({ ...r }));
}

/** FR-1/FR-2 facts for one guardian. `timeZone` = the viewer's zone (018). */
export async function loadFamilyFacts(userId: string, opts: { timeZone: string; now?: Date }): Promise<FamilyFacts> {
  const now = opts.now ?? new Date();
  const timeZone = opts.timeZone;
  const linked = await listLinkedChildren(userId);
  const empty: FamilyFacts = { children: [], visits: [], payments: [], messages: { unread: 0, latest: null }, updates: [], timeZone };
  if (linked.length === 0) {
    // Threads need a child link too, so a guardian without children has nothing else to show.
    return empty;
  }
  const ids = linked.map((c) => c.id);
  const names = new Map(linked.map((c) => [c.id, c.name]));
  const today = todayIn(timeZone, now);
  const weekStart = mondayOf(today);
  const since = addDays(today, -STREAK_LOOKBACK_DAYS);
  const sql = await pg();

  const [visitRows, balanceRows, packageRows, activityRows, logRows, threadRows, teamRows, updateRows] = await Promise.all([
    sql`
      select a.id, a.child_id, a.status, lower(a.slot) as starts_at, upper(a.slot) as ends_at, a.provider_profile_id,
             coalesce(a.service_snapshot ->> 'provider_name', p.display_name) as provider_name, a.service_snapshot as snap,
             a.series_id, a.is_demo, a.hold_expires_at, a.meet_url, a.meet_status,
             t.id as attempt_id, t.status as attempt_status, coalesce(s.granted, false) as intake_consent
      from public.appointments a
      join public.provider_profiles p on p.id = a.provider_profile_id
      left join lateral (
        select id, status from public.intake_attempts
        where appointment_id = a.id and (status = 'completed' or (status in ('issued', 'started') and expires_at > ${now}))
        order by (status = 'completed') desc, created_at desc limit 1
      ) t on true
      left join public.child_consent_state s on s.child_id = a.child_id and s.feature = 'ai_intake_call'
      where a.guardian_user_id = ${userId} and a.child_id = any(${ids}::uuid[]) and upper(a.slot) > ${now}
        and (a.status = 'confirmed' or (a.status = 'pending_payment' and a.hold_expires_at > ${now}))
      order by lower(a.slot), a.id
      limit ${MAX_VISITS}`,
    sql`
      select x.org_id, x.child_id, coalesce(o.public_name, o.name) as org_name, public.fees_balance(x.org_id, x.child_id) as balance
      from (select distinct org_id, child_id from public.family_ledger where child_id = any(${ids}::uuid[])) x
      join public.organizations o on o.id = x.org_id`,
    sql`
      select cp.id, cp.child_id, cp.price_paise, coalesce(o.public_name, o.name) as org_name
      from public.child_packages cp join public.organizations o on o.id = cp.org_id
      where cp.child_id = any(${ids}::uuid[]) and cp.status = 'pending_payment' and cp.offer_expires_at > ${now}
      order by cp.created_at`,
    // 026: active activities of each program's latest guardian-visible publication (as getGuardianHomePrograms).
    sql`
      select p.child_id, (x ->> 'id')::uuid as activity_id, greatest(coalesce((x ->> 'frequency_per_week')::int, 1), 1) as frequency
      from public.home_programs p
      join public.cases c on c.id = p.case_id and c.child_id = p.child_id
      join lateral (
        select * from public.published_versions v
        where v.entity_type = 'home_program' and v.entity_id = p.id
        order by v.version desc limit 1
      ) pv on true
      join public.home_program_publications hpp on hpp.published_version_id = pv.id
      cross join lateral jsonb_array_elements(hpp.activities) x
      join public.home_activities ha on ha.id = (x ->> 'id')::uuid and ha.active
      where p.child_id = any(${ids}::uuid[]) and p.status = 'published' and pv.visible_to_guardian and pv.child_id = p.child_id`,
    sql`
      select l.child_id, l.activity_id, l.done_on::text as done_on
      from public.home_activity_logs l
      where l.child_id = any(${ids}::uuid[]) and l.done_on >= ${since}::date and l.done_on <= ${today}::date`,
    sql`
      select t.id, t.child_id, t.unread,
             (select coalesce(pp.display_name, up.display_name)
              from public.messages m
              left join public.provider_profiles pp on pp.user_id = m.sender_id
              left join public.user_profiles up on up.id = m.sender_id
              where m.thread_id = t.id and m.deleted_at is null and m.sender_id is distinct from ${userId}
              order by m.created_at desc limit 1) as from_name
      from public.list_message_threads(${userId}) t
      where t.unread > 0 and t.archived_at is null and t.child_id = any(${ids}::uuid[])
      order by t.last_message_at desc`,
    // 022: active care team members (still active org members), lead first, as list_child_care_team.
    sql`
      select distinct on (c.child_id, a.user_id) c.child_id, a.user_id, coalesce(pp.display_name, up.display_name) as name,
             (a.care_role = 'lead') as lead, a.assigned_at
      from public.cases c
      join public.case_assignments a on a.case_id = c.id and a.removed_at is null
      join public.org_members m on m.org_id = c.org_id and m.user_id = a.user_id and m.status = 'active'
      left join public.user_profiles up on up.id = a.user_id
      left join public.provider_profiles pp on pp.user_id = a.user_id
      where c.child_id = any(${ids}::uuid[])
      order by c.child_id, a.user_id, (a.care_role = 'lead') desc, a.assigned_at`,
    // The latest published version of each plan / session note / home program / prescription, if guardian-visible.
    sql`
      select * from (
        select distinct on (pv.entity_type, pv.entity_id) pv.entity_type, pv.entity_id, pv.child_id, pv.published_at,
               pv.visible_to_guardian, coalesce(o.public_name, o.name) as org_name, r.kind as report_kind
        from public.published_versions pv
        join public.organizations o on o.id = pv.org_id
        left join public.reports r on pv.entity_type = 'report' and r.id = pv.entity_id
        where pv.child_id = any(${ids}::uuid[]) and pv.entity_type in ('report', 'iep_plan', 'home_program', 'prescription')
        order by pv.entity_type, pv.entity_id, pv.version desc
      ) latest
      where latest.visible_to_guardian and (latest.entity_type <> 'report' or latest.report_kind = 'session_note')
      order by latest.published_at desc
      limit 20`,
  ]);

  const visits: VisitFact[] = visitRows.map((r) => {
    const snap = (r.snap ?? {}) as Snapshot;
    const status = r.attempt_status as IntakeAttemptFact["status"] | null;
    return {
      id: String(r.id),
      child_id: String(r.child_id),
      child_name: names.get(String(r.child_id)) ?? "",
      status: r.status as VisitFact["status"],
      starts_at: iso(r.starts_at),
      ends_at: iso(r.ends_at),
      provider_profile_id: String(r.provider_profile_id),
      provider_name: String(r.provider_name),
      service_name: snap.name ?? "",
      mode: snap.mode === "video" ? "video" : "in_clinic",
      location_name: snap.location?.name ?? null,
      location_address: snap.location?.address ?? null,
      lat: num(snap.location?.lat),
      lng: num(snap.location?.lng),
      clinic_time_zone: snap.location?.time_zone ?? snap.time_zone ?? null,
      series_id: (r.series_id as string | null) ?? null,
      is_demo: Boolean(r.is_demo),
      fee_inr: Number(snap.fee_inr ?? 0),
      hold_expires_at: isoOrNull(r.hold_expires_at),
      has_intake: snap.intake_kind === "child_dev" || snap.intake_kind === "generic",
      intake_consent: Boolean(r.intake_consent),
      attempt: r.attempt_id && status
        ? { id: String(r.attempt_id), status, path: status === "completed" ? null : intakeAttemptPath(String(r.attempt_id)) }
        : null,
      meet_url: (r.meet_url as string | null) ?? null,
      meet_status: (r.meet_status as string | null) ?? null,
    };
  });

  const payments: PaymentFact[] = [
    ...visits
      .filter((v) => v.status === "pending_payment" && v.fee_inr > 0)
      .map((v) => ({
        kind: "appointment" as const,
        child_id: v.child_id,
        child_name: v.child_name,
        amount_paise: v.fee_inr * 100,
        org_name: null,
        href: `/book/${v.provider_profile_id}/pay/${v.id}`,
      })),
    ...balanceRows
      .filter((r) => Number(r.balance) >= MIN_BALANCE_PAISE)
      .map((r) => ({
        kind: "balance" as const,
        child_id: String(r.child_id),
        child_name: names.get(String(r.child_id)) ?? "",
        amount_paise: Number(r.balance),
        org_name: String(r.org_name),
        href: paymentsHref(String(r.child_id)),
      })),
    ...packageRows.map((r) => ({
      kind: "package" as const,
      child_id: String(r.child_id),
      child_name: names.get(String(r.child_id)) ?? "",
      amount_paise: Number(r.price_paise),
      org_name: String(r.org_name),
      href: paymentsHref(String(r.child_id)),
    })),
  ];

  const children: ChildFact[] = linked.map((c) => {
    const acts = activityRows.filter((a) => a.child_id === c.id);
    const actIds = new Set(acts.map((a) => String(a.activity_id)));
    const logs = logRows.filter((l) => l.child_id === c.id && actIds.has(String(l.activity_id)));
    const week = logs.filter((l) => String(l.done_on) >= weekStart);
    const behind = acts.some((a) => week.filter((l) => l.activity_id === a.activity_id).length < Number(a.frequency));
    const team = teamRows
      .filter((t) => t.child_id === c.id && t.name)
      .sort((a, b) => Number(b.lead) - Number(a.lead) || iso(a.assigned_at).localeCompare(iso(b.assigned_at)))
      .map((t) => String(t.name));
    return {
      id: c.id,
      name: c.name,
      date_of_birth: c.date_of_birth,
      care_team: [...new Set(team)],
      home: {
        activities: acts.length,
        logged_today: logs.some((l) => String(l.done_on) === today),
        behind,
        logs_this_week: week.length,
        streak: acts.length ? practiceStreak(logs.map((l) => String(l.done_on)), today) : 0,
      },
    };
  });

  const unread = threadRows.reduce((sum, t) => sum + Number(t.unread), 0);
  const first = threadRows[0];
  const latest: MessageFact | null = first
    ? { thread_id: String(first.id), child_id: String(first.child_id), unread: Number(first.unread), from: (first.from_name as string | null) ?? null }
    : null;

  const KIND: Record<string, CareTeamUpdate["kind"]> = { report: "note", iep_plan: "plan", home_program: "home_program", prescription: "prescription" };
  const PATH: Record<CareTeamUpdate["kind"], string> = { note: "notes", plan: "plan", home_program: "home-program", prescription: "prescriptions" };
  const updates: CareTeamUpdate[] = updateRows.slice(0, MAX_UPDATES).map((r) => {
    const kind = KIND[String(r.entity_type)];
    const childId = String(r.child_id);
    return {
      kind,
      child_id: childId,
      child_name: names.get(childId) ?? "",
      org_name: String(r.org_name),
      published_at: iso(r.published_at),
      href: `/family/children/${childId}/${PATH[kind]}`,
    };
  });

  return { children, visits, payments, messages: { unread, latest }, updates, timeZone };
}

/** FR-3: unread messages of the guardian (Messages badge in the bottom nav). Same gate as 027's thread list. */
export async function familyUnreadCount(userId: string): Promise<number> {
  const sql = await pg();
  const [row] = await sql<{ n: number }[]>`
    select coalesce(sum(t.unread), 0)::int as n from public.list_message_threads(${userId}) t where t.archived_at is null`;
  return Number(row?.n ?? 0);
}
