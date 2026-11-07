import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

const TABLES = ["cases", "recordings", "facts", "reports", "referrals", "case_questions", "audit_events", "pilot_signups"];

async function main() {
  const { default: postgres } = await import("postgres");
  const { env } = await import("../lib/env");
  const sql = postgres(env.DATABASE_URL, { max: 1, onnotice: () => {} });
  let failed = false;
  try {
    for (const table of TABLES) {
      try {
        await sql.unsafe(`select 1 from public.${table} limit 1`);
        console.log(`${table} ok`);
      } catch (err) {
        failed = true;
        console.log(`${table} ERR ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    try {
      const rows = await sql`select id from storage.buckets where id = 'recordings'`;
      if (rows.length !== 1) throw new Error("bucket not found");
      console.log("bucket recordings ok");
    } catch (err) {
      failed = true;
      console.log(`bucket recordings ERR ${err instanceof Error ? err.message : String(err)}`);
    }
  } finally {
    await sql.end({ timeout: 2 });
  }
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
