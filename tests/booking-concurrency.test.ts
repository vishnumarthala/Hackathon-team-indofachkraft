// Ticket 030 NFR-1: concurrency against the real database with parallel connections. Every hold/reschedule below runs
// on its own connection at the same time; the exclusion constraint (and the per-provider lock in the SQL functions)
// must leave exactly one winner and a consistent state. Synthetic data only; skipped without DATABASE_URL.
import { loadEnvConfig } from "@next/env";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bookingWorld, futureSlot, key, sessionHash, type TestProvider } from "./helpers/booking";

loadEnvConfig(process.cwd(), false, { info: () => {}, error: () => {} });
const enabled = Boolean(process.env.DATABASE_URL) && process.env.SKIP_DB_TESTS !== "1";

type HoldRow = { r: { appointment_id: string; status: string } };

describe.skipIf(!enabled)("booking concurrency (database, parallel connections)", { timeout: 120_000 }, () => {
  let sql: Sql;
  let world: ReturnType<typeof bookingWorld>;
  let provider: TestProvider;
  let clinic30: string;
  let clinic45: string;

  /** `n` dedicated connections, opened before the race so the attempts really start together. */
  async function connections(n: number): Promise<Sql[]> {
    const conns = Array.from({ length: n }, () => postgres(process.env.DATABASE_URL as string, { max: 1, prepare: false, onnotice: () => {} }));
    await Promise.all(conns.map((c) => c`select 1`));
    return conns;
  }

  async function closeAll(conns: Sql[]) {
    await Promise.all(conns.map((c) => c.end({ timeout: 5 })));
  }

  function hold(conn: Sql, serviceId: string, start: Date, owner = sessionHash()) {
    return conn<HoldRow[]>`select public.booking_hold(${serviceId}::uuid, ${start.toISOString()}::timestamptz, null, ${owner}, ${key()}) as r`;
  }

  const outcome = (results: PromiseSettledResult<unknown>[]) => ({
    ok: results.filter((r) => r.status === "fulfilled").length,
    errors: results.flatMap((r) => (r.status === "rejected" ? [(r.reason as Error).message] : [])),
  });

  const blockingAt = (start: Date) => sql<{ id: string; status: string }[]>`
    select id, status from appointments
    where provider_profile_id = ${provider.profileId} and status in ('held', 'pending_payment', 'confirmed')
      and slot && tstzrange(${start.toISOString()}::timestamptz, ${start.toISOString()}::timestamptz + interval '1 minute', '[)')`;

  beforeAll(async () => {
    sql = postgres(process.env.DATABASE_URL as string, { max: 4, prepare: false, onnotice: () => {} });
    const db = (await import("@/lib/db")).supabaseAdmin();
    world = bookingWorld(sql, db, "t030c");
    provider = await world.provider("pc");
    clinic30 = await world.service(provider, { duration: 30 });
    clinic45 = await world.service(provider, { duration: 45 });
  });

  afterAll(async () => {
    await world?.cleanup();
    await sql?.end({ timeout: 5 });
  });

  it("50 simultaneous holds on one slot -> exactly 1 held, 49 slot_taken", async () => {
    const start = futureSlot(30);
    const conns = await connections(50);
    try {
      const results = await Promise.allSettled(conns.map((c) => hold(c, clinic30, start)));
      const { ok, errors } = outcome(results);
      console.log(`[NFR-1] 50 parallel holds: ${ok} succeeded, ${errors.filter((e) => e === "slot_taken").length} slot_taken`);
      expect(ok).toBe(1);
      expect(errors).toHaveLength(49);
      expect(new Set(errors)).toEqual(new Set(["slot_taken"]));
    } finally {
      await closeAll(conns);
    }
    const rows = await blockingAt(start);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("held");
  });

  it("30- and 45-minute services overlapping the same time -> exactly 1 success", async () => {
    // A start on both grids (90 min); the 30-minute attempts start 30 minutes later, inside the 45-minute slot.
    const start45 = futureSlot(40, 90);
    const start30 = new Date(start45.getTime() + 30 * 60_000);
    const conns = await connections(20);
    try {
      const results = await Promise.allSettled(conns.map((c, i) => (i % 2 ? hold(c, clinic30, start30) : hold(c, clinic45, start45))));
      const { ok, errors } = outcome(results);
      console.log(`[NFR-1] 10x30-min + 10x45-min overlapping holds: ${ok} succeeded, ${errors.length} slot_taken`);
      expect(ok).toBe(1);
      expect(new Set(errors)).toEqual(new Set(["slot_taken"]));
    } finally {
      await closeAll(conns);
    }
    const rows = await sql<{ n: number }[]>`
      select count(*)::int as n from appointments
      where provider_profile_id = ${provider.profileId} and status = 'held'
        and slot && tstzrange(${start45.toISOString()}::timestamptz, ${start45.toISOString()}::timestamptz + interval '45 minutes', '[)')`;
    expect(rows[0].n).toBe(1);
  });

  it("back-to-back [10:00,10:30) and [10:30,11:00) both succeed (half-open ranges)", async () => {
    const first = futureSlot(50);
    const second = new Date(first.getTime() + 30 * 60_000);
    const conns = await connections(2);
    try {
      const results = await Promise.allSettled([hold(conns[0], clinic30, first), hold(conns[1], clinic30, second)]);
      expect(outcome(results)).toEqual({ ok: 2, errors: [] });
    } finally {
      await closeAll(conns);
    }
  });

  it("two reschedules into the same slot -> 1 success, the loser keeps its original appointment", async () => {
    const { user: guardian, childId } = await world.guardian("gc");
    const confirmed = async (start: Date) => {
      const [h] = await sql<HoldRow[]>`select public.booking_hold(${clinic30}::uuid, ${start.toISOString()}::timestamptz, ${guardian.id}::uuid, null, ${key()}) as r`;
      await sql`select public.booking_attach(${h.r.appointment_id}::uuid, ${guardian.id}::uuid, null, ${guardian.id}::uuid, ${childId}::uuid)`;
      await sql`select public.booking_confirm(${h.r.appointment_id}::uuid, ${guardian.id}::uuid)`;
      return h.r.appointment_id;
    };
    const x = await confirmed(futureSlot(60));
    const y = await confirmed(futureSlot(61));
    const target = futureSlot(70);
    const conns = await connections(2);
    let results: PromiseSettledResult<{ r: { appointment_id: string } }[]>[];
    try {
      results = await Promise.allSettled(
        [x, y].map((id, i) =>
          conns[i]<{ r: { appointment_id: string } }[]>`
            select public.booking_reschedule(${id}::uuid, ${target.toISOString()}::timestamptz, ${guardian.id}::uuid, 'guardian') as r`,
        ),
      );
    } finally {
      await closeAll(conns);
    }
    const { ok, errors } = outcome(results);
    expect(ok).toBe(1);
    expect(errors).toEqual(["slot_taken"]);
    const winner = results.findIndex((r) => r.status === "fulfilled");
    const loserId = winner === 0 ? y : x;
    const winnerId = winner === 0 ? x : y;
    const rows = await sql<{ id: string; status: string; rescheduled_from: string | null; starts: Date }[]>`
      select id, status, rescheduled_from, lower(slot) as starts from appointments where id in (${x}, ${y}) or rescheduled_from in (${x}, ${y})`;
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(loserId)?.status).toBe("confirmed");
    expect(byId.get(winnerId)?.status).toBe("cancelled");
    const moved = rows.filter((r) => r.rescheduled_from === winnerId);
    expect(moved).toHaveLength(1);
    expect(moved[0].status).toBe("confirmed");
    expect(moved[0].starts.toISOString()).toBe(target.toISOString());
    expect(await blockingAt(target)).toHaveLength(1);
  });

  // Without the functions' per-provider lock, concurrent exclusion checks wait on each other and Postgres may abort some
  // with a deadlock (40P01) instead of 23P01 (documented Postgres behaviour). Either way only one row survives; the SQL
  // functions serialise per provider so callers only ever see slot_taken.
  it("the exclusion constraint alone rejects overlaps: parallel raw inserts -> 1 row, the rest 23P01/40P01", async () => {
    const start = futureSlot(80);
    const end = new Date(start.getTime() + 30 * 60_000);
    const conns = await connections(5);
    try {
      const results = await Promise.allSettled(
        conns.map((c) => c`
          insert into appointments (provider_profile_id, org_id, service_snapshot, slot, status, hold_owner_session, hold_expires_at)
          values (${provider.profileId}, ${provider.orgId}, '{"name":"raw","duration_min":30,"mode":"in_clinic","fee_inr":0,"payment_mode":"free","location":null}'::jsonb,
                  tstzrange(${start.toISOString()}::timestamptz, ${end.toISOString()}::timestamptz, '[)'), 'held', ${sessionHash()}, now() + interval '10 minutes')`),
      );
      const ok = results.filter((r) => r.status === "fulfilled").length;
      const codes = results.flatMap((r) => (r.status === "rejected" ? [(r.reason as { code?: string }).code] : []));
      expect(ok).toBe(1);
      expect(codes).toHaveLength(4);
      for (const code of codes) expect(["23P01", "40P01"]).toContain(code);
    } finally {
      await closeAll(conns);
    }
    // Non-blocking statuses never conflict.
    await sql`
      insert into appointments (provider_profile_id, org_id, service_snapshot, slot, status)
      values (${provider.profileId}, ${provider.orgId}, '{"name":"raw","duration_min":30,"mode":"in_clinic","fee_inr":0,"payment_mode":"free","location":null}'::jsonb,
              tstzrange(${start.toISOString()}::timestamptz, ${end.toISOString()}::timestamptz, '[)'), 'cancelled')`;
    // Closed or empty ranges are refused by the half-open check.
    await expect(sql`
      insert into appointments (provider_profile_id, org_id, service_snapshot, slot, status)
      values (${provider.profileId}, ${provider.orgId}, '{}'::jsonb, tstzrange(${start.toISOString()}::timestamptz, ${end.toISOString()}::timestamptz, '[]'), 'cancelled')`).rejects.toMatchObject({ code: "23514" });
  });

  it("concurrent hold + cron cleanup on a stale hold stays consistent (expired, then one new hold)", async () => {
    const start = futureSlot(90);
    const [stale] = await sql<HoldRow[]>`select public.booking_hold(${clinic30}::uuid, ${start.toISOString()}::timestamptz, null, ${sessionHash()}, ${key()}) as r`;
    await sql`update appointments set hold_expires_at = now() - interval '1 minute' where id = ${stale.r.appointment_id}`;
    const conns = await connections(11);
    try {
      const results = await Promise.allSettled([
        conns[10]`select public.booking_expire_stale(null, 1000)`,
        ...conns.slice(0, 10).map((c) => hold(c, clinic30, start)),
      ]);
      expect(results[0].status).toBe("fulfilled");
      expect(outcome(results.slice(1)).ok).toBe(1);
    } finally {
      await closeAll(conns);
    }
    const [row] = await sql<{ status: string }[]>`select status from appointments where id = ${stale.r.appointment_id}`;
    expect(row.status).toBe("expired");
    expect(await blockingAt(start)).toHaveLength(1);
  });
});
