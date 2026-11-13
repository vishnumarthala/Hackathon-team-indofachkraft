// 044 extra scope: one-off, idempotent catch-up that creates the weekly series (043) of imported timetables still
// `pending` (imports made before weekly sessions existed). Each import is scheduled as the owner/admin who made it
// (skipped when they are no longer owner/admin: use the import page's button instead).
// Usage: npm run import:schedule-pending [-- --org <org id>]
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

async function main() {
  const orgFlag = process.argv.indexOf("--org");
  const orgId = orgFlag > -1 ? process.argv[orgFlag + 1] : undefined;
  const { schedulePendingTimetables } = await import("../lib/import/schedule");
  const outcome = await schedulePendingTimetables({ orgId });
  console.log(JSON.stringify(outcome));
  const { pg } = await import("../lib/pg");
  await (await pg()).end({ timeout: 5 });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
