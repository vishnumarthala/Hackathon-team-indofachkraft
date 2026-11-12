// Phone OTP for guardians (ticket 019, FR-1/FR-9). Two backends behind one interface:
// - "supabase": Supabase Auth phone OTP (`signInWithOtp` / `verifyOtp` type sms, `updateUser({ phone })` /
//   `verifyOtp` type phone_change). Needs an SMS provider in the Supabase project (DLT sender in India).
// - "demo": DEMO_MODE only, and only for the synthetic test numbers +91 9000000001..05 with code 123456
//   (the same numbers the Supabase `[auth.sms.test_otp]` setting documents). It creates the session with the
//   admin API, so it works on stacks without an SMS provider. It can never sign in any other number.
// Both run server-side so the app can rate-limit sends and keep phone numbers out of logs (NFR-1, NFR-4).
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/db";
import { env } from "@/lib/env";
import { redactPhones } from "@/lib/family/phone";
import { supabaseRouteClient } from "@/lib/supabase-server";

export const TEST_OTP_PHONES: readonly string[] = [
  "919000000001",
  "919000000002",
  "919000000003",
  "919000000004",
  "919000000005",
];
export const TEST_OTP_CODE = "123456";
/** Hidden login email the demo backend gives phone-only accounts (Supabase sessions need one locally). */
export const DEMO_EMAIL_DOMAIN = "phone.demo.doctornearme.invalid";

export { PHONE_IN_USE_ERROR, WRONG_CODE_ERROR } from "@/lib/family/phone";

export type SendResult = { ok: true } | { ok: false; reason: "rate_limited" | "phone_in_use" | "unavailable" };
export type VerifyResult =
  | { ok: true; userId: string }
  | { ok: false; reason: "invalid_code" | "phone_in_use" | "unavailable" };

export interface PhoneAuthBackend {
  readonly kind: "supabase" | "demo";
  /** Sends a sign-in code (creates the account on first verify; new accounts are guardians). */
  sendSignInCode(phone: string): Promise<SendResult>;
  /** Verifies the code and sets the session cookies. */
  verifySignInCode(phone: string, code: string): Promise<VerifyResult>;
  /** Signed-in user adds a phone: sends a code to the new number. */
  sendPhoneChangeCode(userId: string, phone: string): Promise<SendResult>;
  /** Confirms the new number on the signed-in user's own account. */
  verifyPhoneChangeCode(userId: string, phone: string, code: string): Promise<VerifyResult>;
}

type AuthErrorLike = { message: string; code?: string; status?: number };

function logAuthError(context: string, error: AuthErrorLike) {
  console.error(`[phone-auth] ${context}: ${redactPhones(error.message)}${error.code ? ` (${error.code})` : ""}`);
}

export function isTestOtpPhone(phone: string): boolean {
  return TEST_OTP_PHONES.includes(phone);
}

/** The account that owns this phone (E.164 digits), if any. Server-only RPC. */
export async function findUserIdByPhone(phone: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin().rpc("auth_user_id_by_phone", { target_phone: phone });
  if (error) throw new Error(`Could not look up the phone owner: ${error.message}`);
  return (data as string | null) ?? null;
}

function sendFailure(error: AuthErrorLike): SendResult {
  if (error.code === "over_sms_send_rate_limit" || error.status === 429) return { ok: false, reason: "rate_limited" };
  if (error.code === "phone_exists") return { ok: false, reason: "phone_in_use" };
  return { ok: false, reason: "unavailable" };
}

function verifyFailure(error: AuthErrorLike): VerifyResult {
  if (error.code === "phone_exists") return { ok: false, reason: "phone_in_use" };
  if (error.code === "otp_expired" || error.code === "otp_disabled" || error.status === 400 || error.status === 403) {
    return { ok: false, reason: "invalid_code" };
  }
  return { ok: false, reason: "unavailable" };
}

export function supabasePhoneAuth(client: () => Promise<SupabaseClient> = supabaseRouteClient): PhoneAuthBackend {
  return {
    kind: "supabase",
    async sendSignInCode(phone) {
      const { error } = await (await client()).auth.signInWithOtp({ phone: `+${phone}` });
      if (!error) return { ok: true };
      logAuthError("send sign-in code", error);
      return sendFailure(error);
    },
    async verifySignInCode(phone, code) {
      const { data, error } = await (await client()).auth.verifyOtp({ phone: `+${phone}`, token: code, type: "sms" });
      if (error || !data.user) {
        if (error) logAuthError("verify sign-in code", error);
        return error ? verifyFailure(error) : { ok: false, reason: "unavailable" };
      }
      return { ok: true, userId: data.user.id };
    },
    async sendPhoneChangeCode(_userId, phone) {
      // Uses the signed-in user's own session; Supabase refuses numbers that belong to another user.
      const { error } = await (await client()).auth.updateUser({ phone: `+${phone}` });
      if (!error) return { ok: true };
      logAuthError("send phone change code", error);
      return sendFailure(error);
    },
    async verifyPhoneChangeCode(userId, phone, code) {
      const { data, error } = await (await client()).auth.verifyOtp({
        phone: `+${phone}`,
        token: code,
        type: "phone_change",
      });
      if (error || !data.user) {
        if (error) logAuthError("verify phone change code", error);
        return error ? verifyFailure(error) : { ok: false, reason: "unavailable" };
      }
      if (data.user.id !== userId) return { ok: false, reason: "unavailable" };
      return { ok: true, userId };
    },
  };
}

export function demoPhoneAuth(client: () => Promise<SupabaseClient> = supabaseRouteClient): PhoneAuthBackend {
  const admin = () => supabaseAdmin().auth.admin;
  return {
    kind: "demo",
    async sendSignInCode() {
      return { ok: true };
    },
    async verifySignInCode(phone, code) {
      if (code !== TEST_OTP_CODE) return { ok: false, reason: "invalid_code" };
      let userId = await findUserIdByPhone(phone);
      if (!userId) {
        const created = await admin().createUser({ phone, phone_confirm: true });
        if (created.error || !created.data.user) {
          logAuthError("demo create user", created.error ?? { message: "no user" });
          return { ok: false, reason: "unavailable" };
        }
        userId = created.data.user.id;
      }
      const existing = await admin().getUserById(userId);
      if (existing.error || !existing.data.user) return { ok: false, reason: "unavailable" };
      let email = existing.data.user.email;
      if (!email) {
        email = `guardian-${randomUUID()}@${DEMO_EMAIL_DOMAIN}`;
        const updated = await admin().updateUserById(userId, { email, email_confirm: true });
        if (updated.error) {
          logAuthError("demo set login email", updated.error);
          return { ok: false, reason: "unavailable" };
        }
      }
      const link = await admin().generateLink({ type: "magiclink", email });
      const tokenHash = link.data?.properties?.hashed_token;
      if (link.error || !tokenHash) {
        logAuthError("demo generate link", link.error ?? { message: "no token" });
        return { ok: false, reason: "unavailable" };
      }
      const verified = await (await client()).auth.verifyOtp({ token_hash: tokenHash, type: "magiclink" });
      if (verified.error || verified.data.user?.id !== userId) {
        logAuthError("demo verify link", verified.error ?? { message: "user mismatch" });
        return { ok: false, reason: "unavailable" };
      }
      return { ok: true, userId };
    },
    async sendPhoneChangeCode() {
      return { ok: true };
    },
    async verifyPhoneChangeCode(userId, phone, code) {
      if (code !== TEST_OTP_CODE) return { ok: false, reason: "invalid_code" };
      const owner = await findUserIdByPhone(phone);
      if (owner && owner !== userId) return { ok: false, reason: "phone_in_use" };
      const { error } = await admin().updateUserById(userId, { phone, phone_confirm: true });
      if (error) {
        logAuthError("demo confirm phone", error);
        return { ok: false, reason: "unavailable" };
      }
      return { ok: true, userId };
    },
  };
}

/** Demo backend only in DEMO_MODE and only for the synthetic test numbers; everything else is Supabase. */
export function phoneAuthFor(phone: string): PhoneAuthBackend {
  return env.DEMO_MODE && isTestOtpPhone(phone) ? demoPhoneAuth() : supabasePhoneAuth();
}
