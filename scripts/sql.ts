import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

async function main() {
  const query = process.argv[2];
  if (!query) {
    console.error('usage: npm run -s db:sql -- "<sql>"');
    process.exit(1);
  }
  const { default: postgres } = await import("postgres");
  const { env } = await import("../lib/env");
  const sql = postgres(env.DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    const rows = await sql.unsafe(query);
    console.log(JSON.stringify(Array.from(rows)));
  } finally {
    await sql.end({ timeout: 2 });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
