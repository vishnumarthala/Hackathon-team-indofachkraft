import { z } from "zod";
import { MOBILE_ERROR, normalizeIndianMobile } from "@/lib/family/phone";
import { phoneAuthFor } from "@/lib/family/phone-auth";
import { clientIp, OTP_RATE_LIMIT_ERROR, recordOtpSend } from "@/lib/family/otp-rate-limit";
import { fail, ok, parseJson } from "@/lib/http";
import { verifyTurnstile } from "@/lib/turnstile";
import { VOICE_ERRORS } from "@/lib/voice/constants";

export const dynamic = "force-dynamic";

const schema = z.object({ phone: z.string().max(20) });

// Public (019 FR-1): send a guardian sign-in code. Rate limited per number and per IP (NFR-1).
// 051 FR-8: when Turnstile is configured, a valid `X-Turnstile-Token` is required first (SMS pumping); 400 otherwise.
export async function POST(req: Request) {
  if (!(await verifyTurnstile(req))) return fail(VOICE_ERRORS.botCheck.status, VOICE_ERRORS.botCheck.code);
  const parsed = await parseJson(req, schema);
  if ("response" in parsed) return parsed.response;
  const phone = normalizeIndianMobile(parsed.data.phone);
  if (!phone) return fail(400, MOBILE_ERROR);

  if ((await recordOtpSend(phone, clientIp(req))) !== "ok") return fail(429, OTP_RATE_LIMIT_ERROR);

  const result = await phoneAuthFor(phone).sendSignInCode(phone);
  if (result.ok) return ok({ sent: true });
  if (result.reason === "rate_limited") return fail(429, OTP_RATE_LIMIT_ERROR);
  return fail(502, "Could not send the code. Please try again.");
}
