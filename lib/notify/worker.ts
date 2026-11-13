// FR-4 scheduler work: fan out due outbox events into per-recipient, per-channel notifications, then deliver due
// email/WhatsApp notifications under a lease. Used by POST /api/cron/outbox, drainSoon() (after()) and
// scripts/outbox-run.ts. Logs carry counts and ids only (NFR-3).
import { env } from "@/lib/env";
import { isLocale, type Locale } from "@/lib/i18n/config";
import { pg, type Queryable, type Sql, type Tx } from "@/lib/pg";
import type { UserRole } from "@/lib/auth";
import { runConsumers } from "./consumers";
import { deliverEmail } from "./email";
import { icsUid } from "./ics";
import { failureDecision, MAX_ATTEMPTS, sanitizeError } from "./retry";
import { getJob, runJob } from "./jobs";
import { getTemplate } from "./templates";
import { getTopic, topicEnabled } from "./topics";
import { NotifyError, type Channel, type OutboxEventRow, type Rendered, type SendOutcome } from "./types";
import { deliverWhatsApp } from "./whatsapp";

export type ClaimedNotification = {
  id: string;
  event_id: string;
  recipient_user_id: string;
  channel: Exclude<Channel, "in_app">;
  template: string;
  locale: string;
  attempts: number;
  locked_until: Date;
};

export type Contact = {
  id: string;
  role: UserRole;
  email: string | null;
  phone: string | null;
  email_enabled: boolean;
  whatsapp_enabled: boolean;
};

export type DeliveryJob = {
  notification: ClaimedNotification;
  event: OutboxEventRow;
  contact: Contact;
  rendered: Rendered;
  /** Number of earlier events for the same aggregate (calendar SEQUENCE). */
  icsSequence: number;
};

export type Sender = (job: DeliveryJob) => Promise<SendOutcome>;
export type Senders = Record<"email" | "whatsapp", Sender>;

export const defaultSenders: Senders = {
  email: ({ notification, event, contact, rendered, icsSequence }) =>
    deliverEmail({
      notificationId: notification.id,
      to: contact.email,
      enabled: contact.email_enabled,
      content: rendered.email,
      ics: { uid: icsUid(event.aggregate_type, event.aggregate_id), sequence: icsSequence },
    }),
  whatsapp: ({ notification, contact, rendered }) =>
    deliverWhatsApp({
      notificationId: notification.id,
      phone: contact.phone,
      enabled: contact.whatsapp_enabled,
      content: rendered.whatsapp,
    }),
};

export type RunOptions = {
  sql?: Sql;
  /** Only these events and their notifications (drainSoon). */
  eventIds?: string[];
  eventBatch?: number;
  sendBatch?: number;
  leaseSeconds?: number;
  /** Keep claiming send batches while full, up to this many milliseconds (cron: drain bursts). */
  timeBudgetMs?: number;
  senders?: Partial<Senders>;
  appUrl?: string;
};

export type RunResult = { fanned_out: number; sent: number; failed: number; skipped: number };

const EMPTY: RunResult = { fanned_out: 0, sent: 0, failed: 0, skipped: 0 };

function log(message: string) {
  console.info(`[notify] ${message}`);
}

function appUrlOf(opts: RunOptions): string {
  return opts.appUrl ?? env.NEXT_PUBLIC_APP_URL;
}

const idArray = (sql: Queryable, ids: string[] | undefined) => (ids ? sql`${ids}::bigint[]` : sql`null::bigint[]`);

/** FR-4 cost control: one indexed `exists` query; the cron route returns right away when this is false. */
export async function hasDueWork(sql: Queryable): Promise<boolean> {
  const [row] = await sql<{ due: boolean }[]>`select public.outbox_has_due_work() as due`;
  return row.due;
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

async function fanOutEvent(tx: Queryable, claimed: OutboxEventRow, appUrl: string): Promise<number> {
  // 037: job topics (e.g. `meet.create`) run server work instead of fanning out (lib/notify/jobs.ts).
  const job = getJob(claimed.topic);
  if (job) return runJob(tx as Tx, claimed, job);
  const markDone = () => tx`update public.outbox_events set status = 'fanned_out', fanned_out_at = now() where id = ${claimed.id}`;
  // 035: consumers (lib/notify/consumers.ts) do their domain work first and may enrich the payload.
  const { event, ran } = await runConsumers(tx, claimed);
  const def = getTopic(event.topic);
  if (!def || !topicEnabled(def)) {
    if (!ran) log(`event ${event.id}: topic ${def ? "disabled" : "unknown"} (${event.topic}), no recipients`);
    await markDone();
    return 0;
  }
  const template = getTemplate(def.template);
  const parsed = def.payload.safeParse(event.payload);
  if (!parsed.success || !template) {
    log(`event ${event.id}: ${template ? "invalid payload" : "missing template"} for ${event.topic}, no recipients`);
    await markDone();
    return 0;
  }

  const recipients = [...new Set(await def.recipients(parsed.data, { sql: tx, event }))];
  let inserted = 0;
  if (recipients.length > 0) {
    const profiles = await tx<{ id: string; role: UserRole; preferred_locale: string | null }[]>`
      select id, role, preferred_locale from public.user_profiles where id in ${tx(recipients)}`;
    const rows = profiles.flatMap((profile) => {
      const locale: Locale = isLocale(profile.preferred_locale) ? profile.preferred_locale : "en";
      const rendered = template.render({ payload: parsed.data, locale, role: profile.role, appUrl, event });
      return def.channels.map((channel) => ({
        event_id: event.id,
        recipient_user_id: profile.id,
        channel,
        template: def.template,
        locale,
        // FR-6: in-app is delivered by being written.
        status: channel === "in_app" ? "sent" : "pending",
        sent_at: channel === "in_app" ? new Date() : null,
        title: clip(rendered.title, 200),
        body: clip(rendered.body, 1000),
        link: rendered.link,
      }));
    });
    if (rows.length > 0) {
      const result = await tx`
        insert into public.notifications ${tx(rows)}
        on conflict (event_id, recipient_user_id, channel) do nothing`;
      inserted = result.count;
    }
  }
  await markDone();
  return inserted;
}

/** Fans out due events (row-locked with `skip locked`, so concurrent workers never fan out the same event). */
export async function fanOutDue(sql: Sql, opts: RunOptions = {}): Promise<{ events: number; notifications: number }> {
  const appUrl = appUrlOf(opts);
  let events = 0;
  let notifications = 0;
  await sql.begin(async (tx) => {
    const claimed = await tx<OutboxEventRow[]>`
      select * from public.outbox_claim_events(${opts.eventBatch ?? 50}, ${idArray(tx, opts.eventIds)})`;
    for (const event of claimed) {
      try {
        notifications += await tx.savepoint((sp) => fanOutEvent(sp, event, appUrl));
        events += 1;
      } catch (err) {
        // The event stays pending and is retried on the next run.
        log(`event ${event.id}: fan-out failed: ${sanitizeError(err)}`);
      }
    }
  });
  return { events, notifications };
}

async function loadContacts(sql: Queryable, userIds: string[]): Promise<Map<string, Contact>> {
  const rows = await sql<Contact[]>`
    select u.id, p.role, u.email,
           case when u.phone_confirmed_at is not null and coalesce(u.phone, '') <> '' then u.phone end as phone,
           coalesce(e.enabled, true) as email_enabled,
           coalesce(w.enabled, false) as whatsapp_enabled
    from auth.users u
    join public.user_profiles p on p.id = u.id
    left join public.notification_preferences e on e.user_id = u.id and e.channel = 'email'
    left join public.notification_preferences w on w.user_id = u.id and w.channel = 'whatsapp'
    where u.id in ${sql(userIds)}`;
  return new Map(rows.map((r) => [r.id, r]));
}

async function icsSequenceOf(sql: Queryable, event: OutboxEventRow): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n from public.outbox_events
    where aggregate_type = ${event.aggregate_type} and aggregate_id = ${event.aggregate_id} and id < ${event.id}`;
  return row.n;
}

type Tally = { sent: number; failed: number; skipped: number; dead: number };

async function complete(
  sql: Queryable,
  n: ClaimedNotification,
  status: "sent" | "skipped" | "failed" | "dead",
  extra: { providerMessageId?: string | null; error?: string | null; nextAttemptAt?: Date | null } = {},
): Promise<boolean> {
  const [row] = await sql<{ ok: boolean }[]>`
    select public.notification_complete(${n.id}, ${n.locked_until}, ${status}, ${extra.providerMessageId ?? null},
      ${extra.error ?? null}, ${extra.nextAttemptAt ?? null}) as ok`;
  if (!row.ok) log(`notification ${n.id}: lease lost, outcome not recorded`);
  return row.ok;
}

async function deliverOne(
  sql: Queryable,
  n: ClaimedNotification,
  ctx: { events: Map<string, OutboxEventRow>; contacts: Map<string, Contact>; senders: Senders; appUrl: string },
  tally: Tally,
): Promise<void> {
  const event = ctx.events.get(n.event_id);
  const contact = ctx.contacts.get(n.recipient_user_id);
  const template = getTemplate(n.template);
  if (!event || !contact || !template) {
    await complete(sql, n, "skipped", { error: "no_content" });
    tally.skipped += 1;
    return;
  }
  try {
    const locale: Locale = isLocale(n.locale) ? n.locale : "en";
    const rendered = template.render({ payload: event.payload, locale, role: contact.role, appUrl: ctx.appUrl, event });
    const icsSequence = n.channel === "email" && rendered.email?.ics ? await icsSequenceOf(sql, event) : 0;
    const outcome = await ctx.senders[n.channel]({ notification: n, event, contact, rendered, icsSequence });
    if (outcome.status === "sent") {
      await complete(sql, n, "sent", { providerMessageId: outcome.providerMessageId });
      tally.sent += 1;
    } else {
      await complete(sql, n, "skipped", { error: outcome.reason });
      tally.skipped += 1;
    }
  } catch (err) {
    const permanent = err instanceof NotifyError && err.permanent;
    const code = err instanceof NotifyError ? `${err.code}: ` : "";
    const decision = failureDecision(n.attempts, permanent);
    const error = sanitizeError(`${code}${err instanceof Error ? err.message : String(err)}`);
    await complete(sql, n, decision.status, {
      error,
      nextAttemptAt: decision.status === "failed" ? decision.nextAttemptAt : null,
    });
    if (decision.status === "dead") tally.dead += 1;
    else tally.failed += 1;
    log(`notification ${n.id}: ${decision.status} after attempt ${n.attempts} (${err instanceof NotifyError ? err.code : "error"})`);
  }
}

/** Claims (lease) and delivers one batch of due email/WhatsApp notifications. */
export async function sendDue(sql: Sql, opts: RunOptions = {}): Promise<Tally & { claimed: number }> {
  const tally: Tally = { sent: 0, failed: 0, skipped: 0, dead: 0 };
  const claimed = await sql<ClaimedNotification[]>`
    select id, event_id, recipient_user_id, channel, template, locale, attempts, locked_until
    from public.notifications_claim(${opts.sendBatch ?? 50}, ${opts.leaseSeconds ?? 120}, ${idArray(sql, opts.eventIds)},
      ${MAX_ATTEMPTS})`;
  if (claimed.length === 0) return { ...tally, claimed: 0 };

  const eventIds = [...new Set(claimed.map((n) => n.event_id))];
  const events = new Map(
    (await sql<OutboxEventRow[]>`select * from public.outbox_events where id in ${sql(eventIds)}`).map((e) => [e.id, e]),
  );
  const contacts = await loadContacts(sql, [...new Set(claimed.map((n) => n.recipient_user_id))]);
  const ctx = { events, contacts, senders: { ...defaultSenders, ...opts.senders }, appUrl: appUrlOf(opts) };

  // A few deliveries at a time keeps a cron run short without hammering the providers.
  const queue = [...claimed];
  const workers = Array.from({ length: Math.min(5, queue.length) }, async () => {
    for (let n = queue.shift(); n; n = queue.shift()) await deliverOne(sql, n, ctx, tally);
  });
  await Promise.all(workers);
  return { ...tally, claimed: claimed.length };
}

/** One scheduler pass: cheap due check, fan-out, then deliveries (repeated while batches are full and time allows). */
export async function runOutbox(opts: RunOptions = {}): Promise<RunResult> {
  const sql = opts.sql ?? (await pg());
  if (!opts.eventIds && !(await hasDueWork(sql))) return { ...EMPTY };
  const started = Date.now();
  const budget = opts.timeBudgetMs ?? 0;
  const result: RunResult = { ...EMPTY };

  const fan = await fanOutDue(sql, opts);
  result.fanned_out = fan.events;
  for (;;) {
    const batch = await sendDue(sql, opts);
    result.sent += batch.sent;
    result.failed += batch.failed + batch.dead;
    result.skipped += batch.skipped;
    if (batch.claimed < (opts.sendBatch ?? 50) || Date.now() - started >= budget) break;
  }
  if (result.fanned_out || result.sent || result.failed || result.skipped) {
    log(`run: fanned_out=${result.fanned_out} sent=${result.sent} failed=${result.failed} skipped=${result.skipped}`);
  }
  return result;
}
