import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

const TABLES = [
  "cases",
  "recordings",
  "facts",
  "reports",
  "referrals",
  "case_questions",
  "audit_events",
  "pilot_signups",
  // 020
  "children",
  "guardian_links",
  "consent_documents",
  "consent_records",
  "child_claim_codes",
  "child_consent_state",
];
const BUCKETS = ["recordings", "consent-forms"];

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
    for (const bucket of BUCKETS) {
      try {
        const rows = await sql`select id from storage.buckets where id = ${bucket}`;
        if (rows.length !== 1) throw new Error("bucket not found");
        console.log(`bucket ${bucket} ok`);
      } catch (err) {
        failed = true;
        console.log(`bucket ${bucket} ERR ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // 020 NFR-4 dry-run check: every case belongs to a child after the backfill (expected 0).
    try {
      const [row] = await sql<{ n: number }[]>`select count(*)::int as n from public.cases where child_id is null`;
      console.log(`cases without child_id: ${row.n}`);
      if (row.n !== 0) failed = true;
    } catch (err) {
      failed = true;
      console.log(`cases without child_id ERR ${err instanceof Error ? err.message : String(err)}`);
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
