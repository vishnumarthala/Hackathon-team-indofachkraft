// Ticket 051 FR-2: who may start the landing page's LIVE intake demo (a sales tool, not a parent feature). Everyone
// else hears the recorded sample. Allowed: signed-in provider and platform admin accounts, and leads who booked a demo
// (`pilot_signups`) and signed in with that same, verified email address. The role always comes from the database.
import type { User } from "@supabase/supabase-js";
import { getUserRole } from "@/lib/auth";
import { pg, type Queryable } from "@/lib/pg";

export async function isVerifiedDemoLead(user: Pick<User, "email" | "email_confirmed_at">, sql?: Queryable): Promise<boolean> {
  const email = user.email?.trim().toLowerCase();
  if (!email || !user.email_confirmed_at) return false;
  const db = sql ?? (await pg());
  const rows = await db`select 1 from public.pilot_signups where lower(email) = ${email} limit 1`;
  return rows.length > 0;
}

export async function canUseLiveDemo(user: User | null, sql?: Queryable): Promise<boolean> {
  if (!user) return false;
  const role = await getUserRole(user.id).catch(() => null);
  if (role === "provider" || role === "platform_admin") return true;
  return isVerifiedDemoLead(user, sql);
}
