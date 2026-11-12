// NFR-1: app-level OTP send limits on top of Supabase's own `sms_sent` limit. Counts live in Postgres
// (`record_otp_send`, atomic per number/IP), keyed by HMACs so raw numbers and IPs are never stored.
import { createHmac } from "node:crypto";
import { supabaseAdmin } from "@/lib/db";
import { env } from "@/lib/env";

export const OTP_SENDS_PER_PHONE_PER_HOUR = 5;
export const OTP_SENDS_PER_IP_PER_HOUR = 20;
export const OTP_RATE_LIMIT_ERROR = "Too many codes requested. Try again later.";

export type OtpSendDecision = "ok" | "phone_limited" | "ip_limited";

function keyFor(kind: "phone" | "ip", value: string): string {
  return createHmac("sha256", env.SUPABASE_SERVICE_ROLE_KEY).update(`otp-${kind}:${value}`).digest("hex");
}

/** First hop of `x-forwarded-for` (set by the hosting proxy), then `x-real-ip`. */
export function clientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || req.headers.get("x-real-ip")?.trim() || "unknown";
}

/** Checks both limits and records the send when allowed. `now` comes from the server clock. */
export async function recordOtpSend(phone: string, ip: string, now: Date = new Date()): Promise<OtpSendDecision> {
  const { data, error } = await supabaseAdmin().rpc("record_otp_send", {
    p_phone_key: keyFor("phone", phone),
    p_ip_key: keyFor("ip", ip),
    per_phone: OTP_SENDS_PER_PHONE_PER_HOUR,
    per_ip: OTP_SENDS_PER_IP_PER_HOUR,
    at: now.toISOString(),
  });
  if (error) throw new Error(`Could not check the code limit: ${error.message}`);
  if (data !== "ok" && data !== "phone_limited" && data !== "ip_limited") throw new Error("Unexpected rate limit result");
  return data;
}
