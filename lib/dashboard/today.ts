// Ticket 052 FR-4: the provider dashboard's "Today" panel, To-do counts and the four Figma stat cards. Server only.
// Scope (NFR-2), the same as 044's register and `Needs attention`: in organisations where the user is owner/admin,
// every session of the organisation; where they are a member, only the sessions of their own provider profile.
// Case-based counts (ISAA items, intake briefs, home-program logs) use 022's `accessible_cases` (owner/admin: every
// case of the org; member: assigned cases). Nothing from organisations the user is not an active member of.
// NFR-1: a fixed number of queries whatever the number of children (no per-row queries).
import { listNeedsAttention } from "@/lib/booking/attendance";
import { listManageableConflicts } from "@/lib/booking/series";
import { addDays, todayIn, wallToUtc } from "@/lib/booking/time";
import { listBalancesDue } from "@/lib/fees/store";
import { mondayOf } from "@/lib/home-program/adherence";
import { canManage, listMemberships, type Membership } from "@/lib/orgs";
import { pg, type Queryable } from "@/lib/pg";

if (typeof window !== "undefined") {
  throw new Error("lib/dashboard/today.ts is server-only");
}

export type TodaySession = {
  id: string;
  starts_at: string;
  ends_at: string;
  status: string;
  attendance: "present" | "absent" | "late_cancel_family" | "cancelled_centre" | null;
  child_name: string | null;
  case_id: string | null;
  service_name: string;
  mode: "in_clinic" | "video";
  provider_name: string;
  org_id: string;
  /** A scribe recording or session note is linked to the appointment (038). */
  has_note: boolean;
};

export type TodoKey = "notes" | "attendance" | "isaa" | "briefs" | "messages" | "conflicts" | "balances";
export type TodoItem = { key: TodoKey; count: number; href: string };

export type DashboardStats = {
  /** Children with a session in the last 30 or next 30 days. */
  active_children: number;
  /** Sessions (confirmed, completed, no-show) in the viewer's Monday-start week. */
  sessions_this_week: number;
  /** Present / (present + absent + late family cancellation) over the last 30 days, percent; null = no sessions. */
  attendance_rate: number | null;
  /** Home-program practice logs this week for the children of the user's cases (026). */
  home_logs_this_week: number;
};

export type DashboardToday = {
  memberships: Membership[];
  /** Owner/admin of at least one organisation (balances due are shown only then). */
  manage: boolean;
  date: string;
  sessions: TodaySession[];
  todos: TodoItem[];
  stats: DashboardStats;
};

/** How far back `Notes to write` looks for present sessions without a note. */
export const NOTES_WINDOW_DAYS = 14;
/** The window of `active children` and the attendance rate. */
export const ACTIVE_WINDOW_DAYS = 30;

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));

/** `Write note` target for a session (in-clinic -> the scribe form with the appointment preselected, 044 FR-5). */
export function writeNoteHref(s: { id: string; case_id: string | null; mode: "in_clinic" | "video" }): string | null {
  if (!s.case_id) return null;
  return s.mode === "in_clinic" ? `/cases/${s.case_id}/sessions/new?appointment=${s.id}` : `/cases/${s.case_id}`;
}

function scopeOf(sql: Queryable, userId: string, memberships: Membership[]) {
  const manageIds = memberships.filter((m) => canManage(m.org_role)).map((m) => m.org.id);
  const memberIds = memberships.filter((m) => !canManage(m.org_role)).map((m) => m.org.id);
  const scope = sql`(
    ${manageIds.length ? sql`a.org_id in ${sql(manageIds)}` : sql`false`}
    or (${memberIds.length ? sql`a.org_id in ${sql(memberIds)}` : sql`false`} and p.user_id = ${userId})
  )`;
  return { manageIds, scope };
}

const EFFECTIVE = (sql: Queryable) =>
  sql`coalesce(a.attendance, case a.status when 'completed' then 'present' when 'no_show' then 'absent' end)`;

/** FR-4 for one provider user. `timeZone` = the viewer's zone (018): "today" and "this week" are local. */
export async function loadDashboardToday(userId: string, opts: { timeZone: string; now?: Date }): Promise<DashboardToday> {
  const now = opts.now ?? new Date();
  const date = todayIn(opts.timeZone, now);
  const memberships = await listMemberships(userId);
  if (memberships.length === 0) {
    return {
      memberships,
      manage: false,
      date,
      sessions: [],
      todos: [],
      stats: { active_children: 0, sessions_this_week: 0, attendance_rate: null, home_logs_this_week: 0 },
    };
  }
  const sql = await pg();
  const { manageIds, scope } = scopeOf(sql, userId, memberships);
  const local = (d: string) => wallToUtc(d, 0, opts.timeZone) ?? new Date(`${d}T00:00:00Z`);
  const dayStart = local(date);
  const dayEnd = local(addDays(date, 1));
  const week = mondayOf(date);
  const weekStart = local(week);
  const weekEnd = local(addDays(week, 7));
  const DAY = 86_400_000;
  const noteSince = new Date(now.getTime() - NOTES_WINDOW_DAYS * DAY);
  const activeFrom = new Date(now.getTime() - ACTIVE_WINDOW_DAYS * DAY);
  const activeTo = new Date(now.getTime() + ACTIVE_WINDOW_DAYS * DAY);
  const hasNote = sql`(
    exists (select 1 from public.recordings r where r.appointment_id = a.id)
    or exists (select 1 from public.reports rep where rep.appointment_id = a.id and rep.kind = 'session_note')
  )`;

  const [sessionRows, noteRows, statRows, isaaRows, briefRows, logRows, unreadRows, attention, conflicts, balances] = await Promise.all([
    // Today's sessions: on the register (still to mark, or with an outcome), as 044.
    sql`
      select a.id, lower(a.slot) as starts_at, upper(a.slot) as ends_at, a.status, a.attendance, c.display_name as child_name,
             a.case_id, a.service_snapshot ->> 'name' as service_name, a.service_snapshot ->> 'mode' as mode,
             coalesce(a.service_snapshot ->> 'provider_name', p.display_name) as provider_name, a.org_id, ${hasNote} as has_note
      from public.appointments a
      join public.provider_profiles p on p.id = a.provider_profile_id
      left join public.children c on c.id = a.child_id and c.deleted_at is null
      where ${scope} and lower(a.slot) >= ${dayStart} and lower(a.slot) < ${dayEnd}
        and (a.status in ('confirmed', 'completed', 'no_show') or a.attendance is not null)
      order by lower(a.slot), provider_name, a.id
      limit 200`,
    // Notes to write: present in-clinic sessions of the last 14 days with a case and no recording / note yet.
    sql`
      select a.id, a.case_id, count(*) over () as total
      from public.appointments a
      join public.provider_profiles p on p.id = a.provider_profile_id
      where ${scope} and a.case_id is not null and ${EFFECTIVE(sql)} = 'present'
        and coalesce(a.service_snapshot ->> 'mode', 'in_clinic') = 'in_clinic'
        and lower(a.slot) >= ${noteSince} and lower(a.slot) <= ${now} and not ${hasNote}
      order by lower(a.slot) desc
      limit 1`,
    sql`
      select
        count(distinct a.child_id) filter (where a.child_id is not null and a.status in ('confirmed', 'completed', 'no_show'))::int as active_children,
        count(*) filter (
          where a.status in ('confirmed', 'completed', 'no_show') and lower(a.slot) >= ${weekStart} and lower(a.slot) < ${weekEnd})::int as sessions_week,
        count(*) filter (where ${EFFECTIVE(sql)} = 'present' and lower(a.slot) <= ${now})::int as attended,
        count(*) filter (where ${EFFECTIVE(sql)} in ('present', 'absent', 'late_cancel_family') and lower(a.slot) <= ${now})::int as counted
      from public.appointments a
      join public.provider_profiles p on p.id = a.provider_profile_id
      -- The 30-day windows always contain the current week.
      where ${scope} and lower(a.slot) >= ${activeFrom} and lower(a.slot) < ${activeTo}`,
    // ISAA items the AI suggested and nobody confirmed yet (007), in cases the user can open.
    sql`
      select f.case_id, f.recording_id, count(*) over () as total
      from public.facts f
      join public.accessible_cases(${userId}) c on c.id = f.case_id
      where f.status = 'suggested'
      order by f.created_at
      limit 1`,
    // Intake briefs (010 / 035) still in draft = not marked reviewed.
    sql`
      select r.case_id, count(*) over () as total
      from public.reports r
      join public.accessible_cases(${userId}) c on c.id = r.case_id
      where r.kind in ('pre_session_brief', 'generic_intake_brief') and r.status = 'draft'
      order by r.created_at
      limit 1`,
    sql`
      select count(*)::int as n
      from public.home_activity_logs l
      join public.home_activities ha on ha.id = l.activity_id
      join public.home_programs hp on hp.id = ha.program_id
      join public.accessible_cases(${userId}) c on c.id = hp.case_id
      where l.done_on >= ${week}::date and l.done_on < ${addDays(week, 7)}::date`,
    sql`select coalesce(sum(t.unread), 0)::int as n from public.list_message_threads(${userId}) t where t.archived_at is null`,
    listNeedsAttention(userId, { limit: 1 }),
    listManageableConflicts(userId),
    manageIds.length ? listBalancesDue(manageIds) : Promise.resolve(null),
  ]);

  const sessions: TodaySession[] = sessionRows.map((r) => ({
    id: String(r.id),
    starts_at: iso(r.starts_at),
    ends_at: iso(r.ends_at),
    status: String(r.status),
    attendance: (r.attendance as TodaySession["attendance"]) ?? null,
    child_name: (r.child_name as string | null) ?? null,
    case_id: (r.case_id as string | null) ?? null,
    service_name: String(r.service_name ?? ""),
    mode: r.mode === "video" ? "video" : "in_clinic",
    provider_name: String(r.provider_name),
    org_id: String(r.org_id),
    has_note: Boolean(r.has_note),
  }));

  const note = noteRows[0];
  const isaa = isaaRows[0];
  const brief = briefRows[0];
  const firstAttention = attention.items[0];
  const due = balances ? balances.filter((b) => b.balance_paise > 0) : null;
  const todos: TodoItem[] = [
    {
      key: "notes",
      count: note ? Number(note.total) : 0,
      href: note ? `/cases/${note.case_id}/sessions/new?appointment=${note.id}` : "/dashboard/register",
    },
    {
      key: "attendance",
      count: attention.total,
      href: firstAttention
        ? `/dashboard/register?org=${firstAttention.org_id}&date=${todayIn(opts.timeZone, new Date(firstAttention.starts_at))}`
        : "/dashboard/register",
    },
    { key: "isaa", count: isaa ? Number(isaa.total) : 0, href: isaa ? `/cases/${isaa.case_id}/sessions/${isaa.recording_id}` : "/dashboard" },
    { key: "briefs", count: brief ? Number(brief.total) : 0, href: brief ? `/cases/${brief.case_id}/brief` : "/dashboard" },
    { key: "messages", count: Number(unreadRows[0]?.n ?? 0), href: "/dashboard/messages" },
    { key: "conflicts", count: conflicts.length, href: "/dashboard/schedule" },
    ...(due ? [{ key: "balances" as const, count: due.length, href: "/dashboard/fees" }] : []),
  ];

  const s = statRows[0] ?? {};
  const counted = Number(s.counted ?? 0);
  return {
    memberships,
    manage: manageIds.length > 0,
    date,
    sessions,
    todos,
    stats: {
      active_children: Number(s.active_children ?? 0),
      sessions_this_week: Number(s.sessions_week ?? 0),
      attendance_rate: counted ? Math.round((Number(s.attended ?? 0) / counted) * 100) : null,
      home_logs_this_week: Number(logRows[0]?.n ?? 0),
    },
  };
}

/** The greeting for the viewer's local hour: morning before 12, afternoon before 17, else evening. */
export function greetingPart(timeZone: string, now: Date = new Date()): "morning" | "afternoon" | "evening" {
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hourCycle: "h23" }).format(now));
  return hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
}

/** `Invite parent`: the user's cases whose child has no active parent account yet (newest first). */
export async function listCasesWithoutParent(userId: string, limit = 8): Promise<{ id: string; child_alias: string }[]> {
  const sql = await pg();
  return sql<{ id: string; child_alias: string }[]>`
    select c.id, c.child_alias
    from public.accessible_cases(${userId}) c
    where not exists (
      select 1 from public.guardian_links gl
      join public.children ch on ch.id = gl.child_id and ch.deleted_at is null
      where gl.child_id = c.child_id and gl.status = 'active'
    )
    order by c.created_at desc
    limit ${limit}`;
}

/** The greeting name: the provider profile's display name, else the account's display name. */
export async function providerDisplayName(userId: string): Promise<string | null> {
  const sql = await pg();
  const [row] = await sql<{ name: string | null }[]>`
    select coalesce(
      (select display_name from public.provider_profiles where user_id = ${userId}),
      (select display_name from public.user_profiles where id = ${userId})
    ) as name`;
  return row?.name?.trim() || null;
}
