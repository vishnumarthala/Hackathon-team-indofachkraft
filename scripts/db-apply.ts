// Applies pending supabase/migrations/*.sql to DATABASE_URL (e.g. a Supabase cloud project).
// Tracks versions in supabase_migrations.schema_migrations, the same table the Supabase CLI uses.
import { loadEnvConfig } from "@next/env";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

loadEnvConfig(process.cwd());

async function main() {
  const { default: postgres } = await import("postgres");
  const { env } = await import("../lib/env");
  const sql = postgres(env.DATABASE_URL, { max: 1, onnotice: () => {}, prepare: false });
  try {
    await sql.unsafe(`create schema if not exists supabase_migrations;
      create table if not exists supabase_migrations.schema_migrations (
        version text primary key, statements text[], name text)`);
    const applied = new Set((await sql`select version from supabase_migrations.schema_migrations`).map((r) => r.version));
    const dir = path.join(process.cwd(), "supabase", "migrations");
    const files = readdirSync(dir).filter((f) => /^\d{14}_.+\.sql$/.test(f)).sort();
    let count = 0;
    for (const file of files) {
      const [version, ...rest] = file.replace(/\.sql$/, "").split("_");
      if (applied.has(version)) continue;
      const body = readFileSync(path.join(dir, file), "utf8");
      await sql.begin(async (tx) => {
        await tx.unsafe(body);
        await tx`insert into supabase_migrations.schema_migrations (version, name) values (${version}, ${rest.join("_")})`;
      });
      console.log(`applied ${file}`);
      count++;
    }
    if (count === 0) console.log("up to date");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(`db:push failed: ${err instanceof Error ? err.message.replace(/postgres(ql)?:\/\/\S+/g, "<db-url>") : String(err)}`);
  process.exit(1);
});
