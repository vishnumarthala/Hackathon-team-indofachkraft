// Ticket 051: the voice usage ledger (server only). Every voice start goes through `startVoiceUsage` (one atomic SQL
// call, FR-4/FR-5), the browser reports the end (`endVoiceUsage`, FR-7), the booking cron expires calls that never
// reported and fetches real durations from ElevenLabs (`expireStaleVoiceUsage`, `reconcileVoiceDurations`). Rows hold
// an account id, an agent and seconds: no child data, no transcripts (NFR-3).
import { createHash } from "node:crypto";
import { auditStrict, type SessionAuditActor } from "@/lib/audit";
import { isDemoMode } from "@/lib/demo";
import { getConversation } from "@/lib/elevenlabs/agent";
import { errorMessage, logger } from "@/lib/log";
import { enqueue } from "@/lib/notify/outbox";
import { pg, type Queryable, type Sql } from "@/lib/pg";
import { envVoiceCaps, voiceCostRates, voiceQuota } from "./config";
import { VOICE_AGENTS, VOICE_MAX_SECONDS, type VoiceAgent, type VoiceStartStatus } from "./constants";

const log = logger("voice-usage");

export type VoiceStartResult = {
  status: VoiceStartStatus;
  usageId: string;
  dayUsedSeconds: number;
  dayCapSeconds: number;
  monthUsedSeconds: number;
  monthCapSeconds: number;
};

/** FR-4 / FR-5: quota, concurrency and budget checks plus the reservation, in one SQL call (NFR-2). */
export async function startVoiceUsage(
  userId: string,
  agent: VoiceAgent,
  opts: { sql?: Queryable; reservedSeconds?: number; caps?: { dailySeconds: number; monthlySeconds: number } } = {},
): Promise<VoiceStartResult> {
  const sql = opts.sql ?? (await pg());
  const quota = voiceQuota(agent);
  const env = envVoiceCaps();
  const caps = opts.caps ?? { dailySeconds: env.dailyMinutes * 60, monthlySeconds: env.monthlyMinutes * 60 };
  const [row] = await sql<
    {
      status: VoiceStartStatus;
      usage_id: string;
      day_used_seconds: string;
      day_cap_seconds: string;
      month_used_seconds: string;
      month_cap_seconds: string;
    }[]
  >`
    select * from public.voice_session_start(${userId}::uuid, ${agent}, ${opts.reservedSeconds ?? VOICE_MAX_SECONDS[agent]}::int,
      ${quota.day}::int, ${quota.month}::int, ${caps.dailySeconds}::bigint, ${caps.monthlySeconds}::bigint)`;
  return {
    status: row.status,
    usageId: row.usage_id,
    dayUsedSeconds: Number(row.day_used_seconds),
    dayCapSeconds: Number(row.day_cap_seconds),
    monthUsedSeconds: Number(row.month_used_seconds),
    monthCapSeconds: Number(row.month_cap_seconds),
  };
}

export type BudgetAlert = { level: 80 | 100; period: "day" | "month" };

/** FR-5: the alert a start result calls for: 100 when a start was refused for budget or a cap is used up, else 80. */
export function budgetAlertFor(result: Pick<VoiceStartResult, "status" | "dayUsedSeconds" | "dayCapSeconds" | "monthUsedSeconds" | "monthCapSeconds">): BudgetAlert | null {
  const ratio = (used: number, cap: number) => (cap <= 0 ? 1 : used / cap);
  const day = ratio(result.dayUsedSeconds, result.dayCapSeconds);
  const month = ratio(result.monthUsedSeconds, result.monthCapSeconds);
  const period = month > day ? "month" : "day";
  const worst = Math.max(day, month);
  if (result.status === "budget" || worst >= 1) return { level: 100, period };
  if (worst >= 0.8) return { level: 80, period };
  return null;
}

/** `YYYY-MM-DD` in India: alerts are once per (India) calendar day and level. */
export function indiaDay(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** A stable uuid for an outbox aggregate that is not a row (the alert of one day and level). */
export function stableUuid(key: string): string {
  const h = createHash("sha256").update(key).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function budgetAlertKey(level: 80 | 100, day = indiaDay()): string {
  return `voice.budget_alert:${day}:${level}`;
}

/** FR-5: one outbox alert per day and level to platform admins (the outbox dedup key makes repeats a no-op). */
export async function queueBudgetAlert(alert: BudgetAlert, opts: { sql?: Queryable; now?: Date } = {}): Promise<string> {
  const sql = opts.sql ?? (await pg());
  const key = budgetAlertKey(alert.level, indiaDay(opts.now));
  return enqueue(sql, {
    topic: "voice.budget_alert",
    aggregateType: "voice_budget",
    aggregateId: stableUuid(key),
    payload: { level: alert.level, period: alert.period },
    dedupKey: key,
  });
}

/** Releases a reservation whose call never started (the provider refused): it counts for nothing. */
export async function releaseVoiceUsage(usageId: string, sql?: Queryable): Promise<void> {
  const db = sql ?? (await pg());
  await db`delete from public.voice_usage where id = ${usageId} and status = 'started'`;
}

export type EndedUsage = { id: string; status: "ended" | "expired"; actual_seconds: number; reserved_seconds: number };

/**
 * FR-7: the browser reports the end. The duration is clamped to the reserved seconds (and to the time since the start,
 * plus a little slack). Idempotent: a second report only attaches a missing conversation id. Null for another user's
 * row, a blocked row or an unknown id (the route answers 404).
 */
export async function endVoiceUsage(
  input: { usageId: string; userId: string; seconds: number; conversationId?: string | null },
  sql?: Queryable,
): Promise<EndedUsage | null> {
  const db = sql ?? (await pg());
  const seconds = Math.max(0, Math.floor(input.seconds));
  const rows = await db<EndedUsage[]>`
    update public.voice_usage set
      status = case when status = 'started' then 'ended' else status end,
      ended_at = coalesce(ended_at, now()),
      actual_seconds = case
        when status = 'started' then least(${seconds}::int, reserved_seconds, ceil(extract(epoch from now() - started_at))::int + 5)
        else actual_seconds end,
      conversation_id = coalesce(conversation_id, ${input.conversationId ?? null})
    where id = ${input.usageId}::uuid and user_id = ${input.userId}::uuid and status <> 'blocked'
    returning id, status, actual_seconds, reserved_seconds`;
  return rows[0] ?? null;
}

/** FR-7: calls still `started` at reserved + 2 minutes become `expired` with actual = reserved. */
export async function expireStaleVoiceUsage(sql?: Queryable): Promise<number> {
  const db = sql ?? (await pg());
  const [row] = await db<{ n: number }[]>`select public.voice_usage_expire_stale() as n`;
  return Number(row.n);
}

export type ConversationFetcher = (conversationId: string) => Promise<Record<string, unknown>>;

/**
 * FR-7: real call durations from ElevenLabs for finished calls with a conversation id. Skipped in DEMO_MODE and
 * without an API key. A failed fetch is retried on the next run (for 7 days).
 */
export async function reconcileVoiceDurations(
  opts: { sql?: Queryable; fetchConversation?: ConversationFetcher; limit?: number } = {},
): Promise<number> {
  if (isDemoMode() || !process.env.ELEVENLABS_API_KEY) return 0;
  const db = opts.sql ?? (await pg());
  const fetchConversation = opts.fetchConversation ?? getConversation;
  const due = await db<{ id: string; conversation_id: string }[]>`
    select id, conversation_id from public.voice_usage
    where status in ('ended', 'expired') and conversation_id is not null and reconciled_at is null
      and started_at > now() - interval '7 days'
    order by started_at limit ${opts.limit ?? 20}`;
  let done = 0;
  for (const row of due) {
    try {
      const conversation = await fetchConversation(row.conversation_id);
      const secs = (conversation.metadata as { call_duration_secs?: unknown } | undefined)?.call_duration_secs;
      if (typeof secs !== "number" || !Number.isFinite(secs) || secs < 0) continue;
      await db`
        update public.voice_usage set actual_seconds = ${Math.round(secs)}, reconciled_at = now() where id = ${row.id}`;
      done += 1;
    } catch (err) {
      log.warn("duration fetch failed", { usage_id: row.id, error: errorMessage(err) });
    }
  }
  return done;
}

// ---------- caps (FR-5 / FR-10) ----------

export type VoiceCaps = {
  dailyMinutes: number;
  monthlyMinutes: number;
  envDailyMinutes: number;
  envMonthlyMinutes: number;
  overridden: { daily: boolean; monthly: boolean };
  updatedAt: string | null;
};

export async function getVoiceCaps(sql?: Queryable): Promise<VoiceCaps> {
  const db = sql ?? (await pg());
  const env = envVoiceCaps();
  const [row] = await db<{ daily_minutes_cap: number | null; monthly_minutes_cap: number | null; updated_at: Date }[]>`
    select daily_minutes_cap, monthly_minutes_cap, updated_at from public.voice_settings where id`;
  const daily = row?.daily_minutes_cap ?? null;
  const monthly = row?.monthly_minutes_cap ?? null;
  return {
    dailyMinutes: daily ?? env.dailyMinutes,
    monthlyMinutes: monthly ?? env.monthlyMinutes,
    envDailyMinutes: env.dailyMinutes,
    envMonthlyMinutes: env.monthlyMinutes,
    overridden: { daily: daily !== null, monthly: monthly !== null },
    updatedAt: daily !== null || monthly !== null ? (row?.updated_at?.toISOString?.() ?? null) : null,
  };
}

/** FR-10: a platform admin changes the caps at runtime (null = back to the env value). Audited in the same transaction. */
export async function setVoiceCaps(
  actor: SessionAuditActor,
  caps: { dailyMinutesCap: number | null; monthlyMinutesCap: number | null },
  sql?: Sql,
): Promise<void> {
  const db = sql ?? (await pg());
  await db.begin(async (tx) => {
    const [before] = await tx<{ daily_minutes_cap: number | null; monthly_minutes_cap: number | null }[]>`
      select daily_minutes_cap, monthly_minutes_cap from public.voice_settings where id for update`;
    await tx`
      insert into public.voice_settings (id, daily_minutes_cap, monthly_minutes_cap, updated_at, updated_by)
      values (true, ${caps.dailyMinutesCap}, ${caps.monthlyMinutesCap}, now(), ${actor.actorUserId})
      on conflict (id) do update set daily_minutes_cap = excluded.daily_minutes_cap,
        monthly_minutes_cap = excluded.monthly_minutes_cap, updated_at = now(), updated_by = excluded.updated_by`;
    await auditStrict(
      {
        actor: actor.actor,
        actorUserId: actor.actorUserId,
        actorRole: actor.actorRole,
        action: "voice.caps_updated",
        entity: "voice_settings",
        details: {
          before: { daily_minutes_cap: before?.daily_minutes_cap ?? null, monthly_minutes_cap: before?.monthly_minutes_cap ?? null },
          after: { daily_minutes_cap: caps.dailyMinutesCap, monthly_minutes_cap: caps.monthlyMinutesCap },
        },
      },
      tx,
    );
  });
}

// ---------- admin overview (FR-10) ----------

export type AgentMinutes = Record<VoiceAgent, { minutes: number; starts: number }>;
export type VoiceUsageOverview = {
  today: AgentMinutes;
  month: AgentMinutes;
  totals: { todayMinutes: number; monthMinutes: number };
  cost: { todayUsd: number; monthUsd: number; todayInr: number; monthInr: number; usdPerMinute: number; usdInr: number };
  topUsers: { user_id: string; role: string | null; minutes: number }[];
  blocked: { today: number; month: number; byReason: Record<string, number> };
  caps: VoiceCaps;
};

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

function emptyAgents(): AgentMinutes {
  return Object.fromEntries(VOICE_AGENTS.map((a) => [a, { minutes: 0, starts: 0 }])) as AgentMinutes;
}

/** Minutes per agent today and this month (India calendar), cost estimate, top 10 users (id + role only), blocked starts. */
export async function voiceUsageOverview(sql?: Queryable): Promise<VoiceUsageOverview> {
  const db = sql ?? (await pg());
  const bounds = db`
    select date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata' as day_start,
           date_trunc('month', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata' as month_start`;
  const [{ day_start, month_start }] = await bounds;
  const perAgent = await db<{ agent: VoiceAgent; today_seconds: string; month_seconds: string; today_starts: string; month_starts: string }[]>`
    select agent,
      coalesce(sum(public.voice_usage_seconds(status, reserved_seconds, actual_seconds)) filter (where started_at >= ${day_start}), 0) as today_seconds,
      coalesce(sum(public.voice_usage_seconds(status, reserved_seconds, actual_seconds)), 0) as month_seconds,
      count(*) filter (where started_at >= ${day_start}) as today_starts,
      count(*) as month_starts
    from public.voice_usage
    where started_at >= ${month_start} and status <> 'blocked'
    group by agent`;
  const today = emptyAgents();
  const month = emptyAgents();
  for (const r of perAgent) {
    today[r.agent] = { minutes: round1(Number(r.today_seconds) / 60), starts: Number(r.today_starts) };
    month[r.agent] = { minutes: round1(Number(r.month_seconds) / 60), starts: Number(r.month_starts) };
  }
  const todaySeconds = perAgent.reduce((s, r) => s + Number(r.today_seconds), 0);
  const monthSeconds = perAgent.reduce((s, r) => s + Number(r.month_seconds), 0);

  const top = await db<{ user_id: string; role: string | null; seconds: string }[]>`
    select u.user_id, p.role, sum(public.voice_usage_seconds(u.status, u.reserved_seconds, u.actual_seconds)) as seconds
    from public.voice_usage u left join public.user_profiles p on p.id = u.user_id
    where u.started_at >= ${month_start} and u.status <> 'blocked'
    group by u.user_id, p.role order by seconds desc, u.user_id limit 10`;

  const blocked = await db<{ reason: string; today: string; month: string }[]>`
    select blocked_reason as reason, count(*) filter (where started_at >= ${day_start}) as today, count(*) as month
    from public.voice_usage where status = 'blocked' and started_at >= ${month_start} group by blocked_reason`;

  const rates = voiceCostRates();
  const todayUsd = (todaySeconds / 60) * rates.usdPerMinute;
  const monthUsd = (monthSeconds / 60) * rates.usdPerMinute;
  return {
    today,
    month,
    totals: { todayMinutes: round1(todaySeconds / 60), monthMinutes: round1(monthSeconds / 60) },
    cost: {
      todayUsd: round2(todayUsd),
      monthUsd: round2(monthUsd),
      todayInr: round2(todayUsd * rates.usdInr),
      monthInr: round2(monthUsd * rates.usdInr),
      ...rates,
    },
    topUsers: top.map((r) => ({ user_id: r.user_id, role: r.role, minutes: round1(Number(r.seconds) / 60) })),
    blocked: {
      today: blocked.reduce((s, r) => s + Number(r.today), 0),
      month: blocked.reduce((s, r) => s + Number(r.month), 0),
      byReason: Object.fromEntries(blocked.map((r) => [r.reason, Number(r.month)])),
    },
    caps: await getVoiceCaps(db),
  };
}
