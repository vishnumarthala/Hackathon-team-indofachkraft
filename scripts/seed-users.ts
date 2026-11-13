// Synthetic test accounts for local development (ticket 019 FR-12). Local Supabase only.
// Usage: npm run -s seed:users -- --prefix <acct> [--extra-member]
// --extra-member (022) adds `provider_a2`, a second plain member of org A who is not assigned to any case.
// Prints JSON with the accounts, their passwords (new random password on every run) and the two orgs.
// Later tickets extend ACCOUNTS / the org setup here instead of writing their own seed script.
import { loadEnvConfig } from "@next/env";
import { randomBytes } from "node:crypto";

loadEnvConfig(process.cwd(), false, { info: () => {}, error: console.error });

type Role = "guardian" | "provider" | "platform_admin";
type Account = { key: string; role: Role; phone?: string };

const ACCOUNTS: Account[] = [
  { key: "guardian_a", role: "guardian", phone: "919000000001" },
  { key: "guardian_b", role: "guardian", phone: "919000000002" },
  { key: "provider_a", role: "provider" },
  { key: "org_admin_a", role: "provider" },
  { key: "provider_b", role: "provider" },
  { key: "platform_admin", role: "platform_admin" },
];

const EXTRA_MEMBER: Account = { key: "provider_a2", role: "provider" };

const SEED_EMAIL_DOMAIN = "example.test";

export function isLocalSupabaseUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const host = new URL(value).hostname;
    return host === "127.0.0.1" || host === "localhost";
  } catch {
    return false;
  }
}

function parsePrefix(argv: string[]): string {
  const index = argv.indexOf("--prefix");
  const prefix = index >= 0 ? argv[index + 1] : "acct";
  if (!prefix || !/^[a-z0-9][a-z0-9-]{0,30}$/.test(prefix)) {
    throw new Error("usage: npm run -s seed:users -- --prefix <acct>  (lowercase letters, digits, hyphens)");
  }
  return prefix;
}

async function main() {
  if (!isLocalSupabaseUrl(process.env.NEXT_PUBLIC_SUPABASE_URL)) {
    throw new Error("seed:users only runs against a local Supabase (NEXT_PUBLIC_SUPABASE_URL on 127.0.0.1 or localhost)");
  }
  const prefix = parsePrefix(process.argv.slice(2));
  const extraMember = process.argv.includes("--extra-member");
  const { default: postgres } = await import("postgres");
  const { env } = await import("../lib/env");
  const { supabaseAdmin } = await import("../lib/db");
  const { createOrganization } = await import("../lib/orgs");
  const admin = supabaseAdmin().auth.admin;
  const sql = postgres(env.DATABASE_URL, { max: 1, onnotice: () => {} });

  try {
    const result: Record<string, { id: string; email: string; password: string; role: Role; phone: string | null }> = {};
    for (const account of extraMember ? [...ACCOUNTS, EXTRA_MEMBER] : ACCOUNTS) {
      const email = `${prefix}-${account.key.replace(/_/g, "-")}@${SEED_EMAIL_DOMAIN}`;
      const password = `${prefix}-${randomBytes(9).toString("base64url")}`;

      if (account.phone) {
        // A test phone held by another synthetic seed account moves to this one (never a non-seed account).
        const holders = await sql<{ id: string; email: string | null }[]>`
          select id, email from auth.users where phone = ${account.phone} and lower(coalesce(email, '')) <> lower(${email})`;
        for (const holder of holders) {
          if (!holder.email?.endsWith(`@${SEED_EMAIL_DOMAIN}`)) {
            throw new Error(`Test phone ending ${account.phone.slice(-4)} belongs to a non-seed account; remove it first`);
          }
          await sql.begin(async (tx) => {
            await tx`delete from auth.identities where user_id = ${holder.id} and provider = 'phone'`;
            await tx`update auth.users set phone = null, phone_confirmed_at = null where id = ${holder.id}`;
          });
        }
      }

      const [existing] = await sql<{ id: string }[]>`select id from auth.users where lower(email) = lower(${email})`;
      const attributes = {
        email,
        password,
        email_confirm: true,
        app_metadata: { role: account.role },
        ...(account.phone ? { phone: account.phone, phone_confirm: true } : {}),
      };
      const { data, error } = existing
        ? await admin.updateUserById(existing.id, attributes)
        : await admin.createUser(attributes);
      if (error || !data.user) throw new Error(`Could not save ${account.key}: ${error?.message ?? "no user"}`);
      // The auth trigger only sets the role on insert; re-runs keep the seeded role (local data only).
      await sql`update user_profiles set role = ${account.role} where id = ${data.user.id}`;
      result[account.key] = {
        id: data.user.id,
        email,
        password,
        role: account.role,
        phone: account.phone ? `+${account.phone}` : null,
      };
    }

    async function ensureOrg(ownerKey: string, name: string, kind: "centre" | "solo") {
      const ownerId = result[ownerKey].id;
      const [found] = await sql<{ id: string }[]>`select id from organizations where name = ${name} and created_by = ${ownerId}`;
      const id = found?.id ?? (await createOrganization(ownerId, { name, kind, city: "Hyderabad" })).id;
      await sql`
        insert into org_members (org_id, user_id, org_role, status) values (${id}, ${ownerId}, 'owner', 'active')
        on conflict (org_id, user_id) do update set org_role = 'owner', status = 'active', revoked_at = null`;
      return { id, name };
    }

    const orgA = await ensureOrg("org_admin_a", `${prefix} Centre A (synthetic)`, "centre");
    const orgB = await ensureOrg("provider_b", `${prefix} Solo B (synthetic)`, "solo");
    await sql`
      insert into org_members (org_id, user_id, org_role, status) values (${orgA.id}, ${result.provider_a.id}, 'member', 'active')
      on conflict (org_id, user_id) do update set org_role = 'member', status = 'active', revoked_at = null`;
    if (extraMember) {
      await sql`
        insert into org_members (org_id, user_id, org_role, status) values (${orgA.id}, ${result.provider_a2.id}, 'member', 'active')
        on conflict (org_id, user_id) do update set org_role = 'member', status = 'active', revoked_at = null`;
    }

    // 022: members only see cases they are assigned to, so provider_a joins the care team of org A's cases
    // (new cases get their creator as lead automatically). provider_a2 stays unassigned on purpose.
    const unassigned = await sql<{ id: string }[]>`
      select c.id from cases c
      where c.org_id = ${orgA.id}
        and not exists (
          select 1 from case_assignments a where a.case_id = c.id and a.user_id = ${result.provider_a.id} and a.removed_at is null
        )`;
    for (const row of unassigned) {
      await sql`select public.add_case_assignment(${row.id}, ${result.provider_a.id}, 'member', null, ${result.org_admin_a.id})`;
    }

    console.log(
      JSON.stringify(
        {
          prefix,
          users: result,
          orgs: { org_a: orgA, org_b: orgB },
          otp: { code: "123456", signup_test_phones: ["+919000000003", "+919000000004", "+919000000005"] },
        },
        null,
        2,
      ),
    );
  } finally {
    await sql.end({ timeout: 2 });
  }
}

if (process.argv[1]?.endsWith("seed-users.ts")) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
