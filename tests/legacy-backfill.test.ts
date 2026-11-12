// Ticket 020 FR-3 / NFR-4 / D-2: legacy cases get unclaimed `legacy_case` children; the backfill is idempotent
// and never creates guardian links or consent. The legacy state (nullable child_id, no auto-child trigger) is
// recreated inside one transaction that is always rolled back. Local Supabase stack only; synthetic data.
import { randomUUID } from "node:crypto";
import { loadEnvConfig } from "@next/env";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

loadEnvConfig(process.cwd(), false, { info: () => {}, error: () => {} });
const enabled = Boolean(process.env.DATABASE_URL) && process.env.SKIP_DB_TESTS !== "1";

class Rollback extends Error {}

describe.skipIf(!enabled)("legacy backfill (database)", { timeout: 60_000 }, () => {
  let sql: Sql;

  beforeAll(() => {
    sql = postgres(process.env.DATABASE_URL as string, { max: 2, prepare: false, onnotice: () => {} });
  });
  afterAll(async () => {
    await sql?.end({ timeout: 5 });
  });

  it("every case has a child after the migration", async () => {
    const [row] = await sql<{ n: number }[]>`select count(*)::int as n from cases where child_id is null`;
    expect(row.n).toBe(0);
  });

  it("running the backfill twice creates no duplicate children, links or consent", async () => {
    const ids = [randomUUID(), randomUUID()];
    let observed: Record<string, unknown> = {};
    await sql
      .begin(async (tx) => {
        await tx`set local lock_timeout = '10s'`;
        await tx`alter table cases alter column child_id drop not null`;
        await tx`alter table cases disable trigger cases_assign_child`;
        for (const id of ids) {
          await tx`
            insert into cases (id, org_id, child_alias, parent_alias, parent_email, parent_phone, created_at)
            values (${id}, '00000000-0000-4000-8000-00000000a001', ${`t020 legacy ${id.slice(0, 6)} (synthetic)`},
                    'Parent (synthetic)', 'legacy-parent@example.test', '+91 90000 00001', now() - interval '30 days')`;
        }
        const [first] = await tx<{ n: number }[]>`select public.backfill_case_children() as n`;
        const [second] = await tx<{ n: number }[]>`select public.backfill_case_children() as n`;
        const kids = await tx<{ source: string; display_name: string; created_by: string | null }[]>`
          select ch.source, ch.display_name, ch.created_by from cases c join children ch on ch.id = c.child_id
          where c.id in ${tx(ids)} order by ch.display_name`;
        const [links] = await tx<{ n: number }[]>`
          select count(*)::int as n from guardian_links gl join cases c on c.child_id = gl.child_id where c.id in ${tx(ids)}`;
        const [consents] = await tx<{ n: number }[]>`
          select count(*)::int as n from consent_records r join cases c on c.child_id = r.child_id where c.id in ${tx(ids)}`;
        const [distinct] = await tx<{ n: number }[]>`select count(distinct child_id)::int as n from cases where id in ${tx(ids)}`;
        observed = { first: first.n, second: second.n, kids, links: links.n, consents: consents.n, distinct: distinct.n };
        throw new Rollback();
      })
      .catch((err: unknown) => {
        if (!(err instanceof Rollback)) throw err;
      });

    expect(observed.first).toBeGreaterThanOrEqual(2);
    expect(observed.second).toBe(0);
    expect(observed.distinct).toBe(2);
    expect(observed.kids).toEqual(
      ids
        .map((id) => ({ source: "legacy_case", display_name: `t020 legacy ${id.slice(0, 6)} (synthetic)`, created_by: null }))
        .sort((a, b) => a.display_name.localeCompare(b.display_name)),
    );
    expect(observed.links).toBe(0); // never inferred from parent email/phone
    expect(observed.consents).toBe(0); // never fabricated
    const [gone] = await sql<{ n: number }[]>`select count(*)::int as n from cases where id in ${sql(ids)}`;
    expect(gone.n).toBe(0);
    const [nn] = await sql<{ is_nullable: string }[]>`
      select is_nullable from information_schema.columns where table_name = 'cases' and column_name = 'child_id'`;
    expect(nn.is_nullable).toBe("NO");
  });

  it("new provider cases get their own unclaimed child (rule 2) and an intake token lifetime", async () => {
    const id = randomUUID();
    try {
      await sql`
        insert into cases (id, org_id, child_alias, parent_alias, intake_token)
        values (${id}, '00000000-0000-4000-8000-00000000a001', 't020 new (synthetic)', 'P', ${`t020tok${id.slice(0, 8)}`})`;
      const [row] = await sql<{ source: string; links: number; expires_in_days: number }[]>`
        select ch.source,
               (select count(*)::int from guardian_links gl where gl.child_id = ch.id) as links,
               round(extract(epoch from (c.intake_token_expires_at - now())) / 86400)::int as expires_in_days
        from cases c join children ch on ch.id = c.child_id where c.id = ${id}`;
      expect(row).toEqual({ source: "provider", links: 0, expires_in_days: 7 });
    } finally {
      const [c] = await sql<{ child_id: string }[]>`delete from cases where id = ${id} returning child_id`;
      if (c) await sql`delete from children where id = ${c.child_id}`;
    }
  });
});
