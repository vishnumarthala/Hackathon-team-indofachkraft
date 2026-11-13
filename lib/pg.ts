import type postgres from "postgres";
import { env } from "@/lib/env";

// Shared server-side Postgres pool (DATABASE_URL) for code that needs real transactions (`sql.begin`), e.g. the
// notifications outbox. Same global as lib/facts.ts and lib/intake/process.ts, so one pool per process.
export type Sql = postgres.Sql;
export type Tx = postgres.TransactionSql;
/** Either the pool or an open transaction: producers pass their transaction so writes commit together. */
export type Queryable = Sql | Tx;

const globalForSql = globalThis as unknown as { __carethreadSql?: Sql };

export async function pg(): Promise<Sql> {
  if (typeof window !== "undefined") throw new Error("lib/pg.ts is server-only");
  if (!globalForSql.__carethreadSql) {
    const { default: postgresClient } = await import("postgres");
    // prepare: false keeps it working behind the Supabase pooler as well as against local Postgres.
    globalForSql.__carethreadSql = postgresClient(env.DATABASE_URL, { max: 5, prepare: false, onnotice: () => {} });
  }
  return globalForSql.__carethreadSql;
}
