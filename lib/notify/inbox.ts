// FR-7 / FR-8 / FR-9 data access: the signed-in user's in-app inbox, channel preferences and the admin ops view.
// Callers authorise first (own rows only: every query here is scoped by the user id passed in).
import { pg, type Queryable } from "@/lib/pg";
import { NOTIFICATION_STATUSES, type Channel, type NotificationStatus, type OptionalChannel } from "./types";

export const PAGE_SIZE = 20;

export type InboxItem = {
  id: string;
  title: string;
  body: string;
  link: string | null;
  created_at: string;
  read_at: string | null;
};

type Cursor = { t: string; id: string };

/** `t` is Postgres' text form of `created_at` (microsecond precision; a JS Date would drop the microseconds). */
export function encodeCursor(item: { t: string; id: string }): string {
  return Buffer.from(JSON.stringify({ t: item.t, id: item.id })).toString("base64url");
}

export function decodeCursor(value: string | null | undefined): Cursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<Cursor>;
    if (typeof parsed.t !== "string" || parsed.t.length > 40 || Number.isNaN(Date.parse(parsed.t))) return null;
    if (typeof parsed.id !== "string" || !/^[0-9a-f-]{36}$/i.test(parsed.id)) return null;
    return { t: parsed.t, id: parsed.id };
  } catch {
    return null;
  }
}

export async function unreadCount(userId: string, sql?: Queryable): Promise<number> {
  const db = sql ?? (await pg());
  const [row] = await db<{ n: number }[]>`
    select count(*)::int as n from public.notifications
    where recipient_user_id = ${userId} and channel = 'in_app' and read_at is null`;
  return row.n;
}

export async function listInbox(
  userId: string,
  cursor: Cursor | null,
  sql?: Queryable,
): Promise<{ items: InboxItem[]; next_cursor: string | null; unread: number }> {
  const db = sql ?? (await pg());
  type Row = Omit<InboxItem, "created_at" | "read_at"> & { created_at: Date; read_at: Date | null; cursor_t: string };
  const rows = await db<Row[]>`
    select id, coalesce(title, '') as title, coalesce(body, '') as body, link, created_at, read_at,
           created_at::text as cursor_t
    from public.notifications
    where recipient_user_id = ${userId} and channel = 'in_app'
      ${cursor ? db`and (created_at, id) < (${cursor.t}::timestamptz, ${cursor.id}::uuid)` : db``}
    order by created_at desc, id desc
    limit ${PAGE_SIZE + 1}`;
  const page = rows.slice(0, PAGE_SIZE);
  const last = page[page.length - 1];
  const next = rows.length > PAGE_SIZE ? encodeCursor({ t: last.cursor_t, id: last.id }) : null;
  const items: InboxItem[] = page.map((r) => ({
    id: r.id,
    title: r.title,
    body: r.body,
    link: r.link,
    created_at: r.created_at.toISOString(),
    read_at: r.read_at ? r.read_at.toISOString() : null,
  }));
  return { items, next_cursor: next, unread: await unreadCount(userId, db) };
}

/** Marks the user's own unread in-app rows read; ids of other users' rows simply match nothing. */
export async function markRead(userId: string, target: { ids: string[] } | { all: true }, sql?: Queryable): Promise<number> {
  const db = sql ?? (await pg());
  const result =
    "all" in target
      ? await db`
          update public.notifications set read_at = now()
          where recipient_user_id = ${userId} and channel = 'in_app' and read_at is null`
      : await db`
          update public.notifications set read_at = now()
          where recipient_user_id = ${userId} and channel = 'in_app' and read_at is null
            and id in ${db(target.ids)}`;
  return result.count;
}

export type Preferences = Record<OptionalChannel, boolean>;

/** Defaults: email on, WhatsApp off until the user opts in (Meta requires opt-in for business-initiated messages). */
export const DEFAULT_PREFERENCES: Preferences = { email: true, whatsapp: false };

export async function getPreferences(userId: string, sql?: Queryable): Promise<Preferences> {
  const db = sql ?? (await pg());
  const rows = await db<{ channel: OptionalChannel; enabled: boolean }[]>`
    select channel, enabled from public.notification_preferences where user_id = ${userId}`;
  const prefs = { ...DEFAULT_PREFERENCES };
  for (const r of rows) prefs[r.channel] = r.enabled;
  return prefs;
}

export async function setPreferences(userId: string, prefs: Preferences, sql?: Queryable): Promise<Preferences> {
  const db = sql ?? (await pg());
  const rows = (Object.keys(DEFAULT_PREFERENCES) as OptionalChannel[]).map((channel) => ({
    user_id: userId,
    channel,
    enabled: prefs[channel],
  }));
  await db`
    insert into public.notification_preferences ${db(rows)}
    on conflict (user_id, channel) do update set enabled = excluded.enabled, updated_at = now()`;
  return getPreferences(userId, db);
}

// ---------- FR-9 admin ops ----------

export type StatusCounts = Record<Channel, Record<NotificationStatus, number>>;

export type ProblemRow = {
  id: string;
  channel: Channel;
  template: string;
  status: "failed" | "dead";
  attempts: number;
  last_error: string | null;
  last_attempt_at: string | null;
  next_attempt_at: string;
  topic: string;
};

export async function adminOverview(sql?: Queryable): Promise<{
  counts: StatusCounts;
  events: Record<string, number>;
  problems: ProblemRow[];
}> {
  const db = sql ?? (await pg());
  const empty = () => Object.fromEntries(NOTIFICATION_STATUSES.map((s) => [s, 0])) as Record<NotificationStatus, number>;
  const counts: StatusCounts = { in_app: empty(), email: empty(), whatsapp: empty() };
  const rows = await db<{ channel: Channel; status: NotificationStatus; n: number }[]>`
    select channel, status, count(*)::int as n from public.notifications group by channel, status`;
  for (const r of rows) counts[r.channel][r.status] = r.n;
  const eventRows = await db<{ status: string; n: number }[]>`
    select status, count(*)::int as n from public.outbox_events group by status`;
  const events = Object.fromEntries(eventRows.map((r) => [r.status, r.n]));
  // No title/body: the ops view shows delivery metadata only.
  const problems = await db<(Omit<ProblemRow, "last_attempt_at" | "next_attempt_at"> & { last_attempt_at: Date | null; next_attempt_at: Date })[]>`
    select n.id, n.channel, n.template, n.status, n.attempts, n.last_error, n.last_attempt_at, n.next_attempt_at, e.topic
    from public.notifications n join public.outbox_events e on e.id = n.event_id
    where n.status in ('failed', 'dead')
    order by n.last_attempt_at desc nulls last, n.id
    limit 50`;
  return {
    counts,
    events,
    problems: problems.map((p) => ({
      ...p,
      last_attempt_at: p.last_attempt_at ? p.last_attempt_at.toISOString() : null,
      next_attempt_at: p.next_attempt_at.toISOString(),
    })),
  };
}

/** FR-9 `Retry`: dead -> pending, audited in the same transaction. False when the row is not dead (or missing). */
export async function retryDead(notificationId: string, adminId: string, sql?: Queryable): Promise<boolean> {
  const db = sql ?? (await pg());
  const [row] = await db<{ ok: boolean }[]>`select public.notification_retry(${notificationId}, ${adminId}) as ok`;
  return row.ok;
}
