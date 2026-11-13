// Adds an existing account to an organisation (default: the bootstrap pilot centre).
// Usage: npm run -s org:grant -- <email> [owner|admin|member] [org-id]
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

const ROLES = new Set(["owner", "admin", "member"]);

async function main() {
  const [email, role = "member", orgIdArg] = process.argv.slice(2);
  if (!email || !ROLES.has(role)) {
    console.error("usage: npm run -s org:grant -- <email> [owner|admin|member] [org-id]");
    process.exit(1);
  }
  const { default: postgres } = await import("postgres");
  const { env } = await import("../lib/env");
  const { BOOTSTRAP_ORG_ID } = await import("../lib/orgs");
  const orgId = orgIdArg ?? BOOTSTRAP_ORG_ID;
  const sql = postgres(env.DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    const users = await sql<{ id: string }[]>`select id from auth.users where lower(email) = lower(${email})`;
    if (users.length === 0) throw new Error(`No account with email ${email}`);
    const userId = users[0].id;
    await sql.begin(async (tx) => {
      await tx`
        insert into org_members (org_id, user_id, org_role, status)
        values (${orgId}, ${userId}, ${role}, 'active')
        on conflict (org_id, user_id) do update set org_role = excluded.org_role, status = 'active', revoked_at = null`;
      await tx`update user_profiles set role = 'provider' where id = ${userId} and role = 'guardian'`;
    });
    console.log(`${email} is now ${role} of organisation ${orgId}`);
    if (role === "member") {
      console.log("Note (022): members only see cases they are assigned to (case Team tab); owners/admins see all.");
    }
  } finally {
    await sql.end({ timeout: 2 });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
