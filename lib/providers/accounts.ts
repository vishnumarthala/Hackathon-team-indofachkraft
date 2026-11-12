// Provider account creation for /join (ticket 028 FR-2). Supabase public sign-up is disabled in this project
// (accounts are created server-side), so the server creates the email/password account:
// - DEMO_MODE: confirmed immediately so the pilot can sign in straight away;
// - otherwise: unconfirmed, with a Supabase confirmation link sent through Resend.
// The new account gets no privileged role here: the role comes from the auth trigger and only
// POST /api/providers/register (server-side checks) turns it into a provider.
import { supabaseAdmin } from "@/lib/db";
import { sendEmail } from "@/lib/email";
import { env } from "@/lib/env";

export const PER_IP_LIMIT = 5;
export const PER_IP_WINDOW_MS = 60 * 60_000;
export const GLOBAL_LIMIT = 100;

const byIp = new Map<string, number[]>();
let global: number[] = [];

// In-memory, per server instance: stops casual abuse of the public sign-up endpoint, not a hard quota.
export function allowJoin(ip: string, now = Date.now()): boolean {
  const recent = (times: number[]) => times.filter((t) => now - t < PER_IP_WINDOW_MS);
  global = recent(global);
  const mine = recent(byIp.get(ip) ?? []);
  if (mine.length >= PER_IP_LIMIT || global.length >= GLOBAL_LIMIT) {
    byIp.set(ip, mine);
    return false;
  }
  mine.push(now);
  global.push(now);
  byIp.set(ip, mine);
  return true;
}

export function resetJoinLimits(): void {
  byIp.clear();
  global = [];
}

export type JoinOutcome = { ok: true; confirmEmail: boolean } | { ok: false; status: number; error: string };

const EXISTS = /already (been )?registered|already exists/i;

export async function createProviderAccount(input: {
  email: string;
  password: string;
  full_name: string;
  provider_type?: string;
}): Promise<JoinOutcome> {
  const db = supabaseAdmin();
  const metadata = { full_name: input.full_name, ...(input.provider_type ? { provider_type: input.provider_type } : {}) };
  const exists: JoinOutcome = {
    ok: false,
    status: 409,
    error: "An account with this email already exists. Sign in, then open this page again.",
  };

  if (env.DEMO_MODE) {
    const { error } = await db.auth.admin.createUser({
      email: input.email,
      password: input.password,
      email_confirm: true,
      user_metadata: metadata,
    });
    if (error) {
      if (EXISTS.test(error.message)) return exists;
      throw new Error(`Could not create account: ${error.message}`);
    }
    return { ok: true, confirmEmail: false };
  }

  const appUrl = env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "");
  const { data, error } = await db.auth.admin.generateLink({
    type: "signup",
    email: input.email,
    password: input.password,
    options: { data: metadata, redirectTo: `${appUrl}/login?next=/join` },
  });
  if (error) {
    if (EXISTS.test(error.message)) return exists;
    throw new Error(`Could not create account: ${error.message}`);
  }
  try {
    await sendEmail({
      to: input.email,
      subject: "Confirm your email for DoctorNearMe",
      text:
        `Hello ${input.full_name},\n\nConfirm your email to finish creating your DoctorNearMe provider account: ` +
        `${data.properties.action_link}\n\nThen sign in and open ${appUrl}/join to create your profile.`,
    });
  } catch (err) {
    // Without the email the account could never be confirmed; remove it so the person can retry.
    console.error(`join confirmation email failed: ${err instanceof Error ? err.message : String(err)}`);
    await db.auth.admin.deleteUser(data.user.id);
    return { ok: false, status: 502, error: "Could not send the confirmation email. Please try again." };
  }
  return { ok: true, confirmEmail: true };
}
