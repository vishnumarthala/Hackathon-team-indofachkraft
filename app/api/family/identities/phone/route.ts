import { z } from "zod";
import { requireGuardian } from "@/lib/authz";
import { MOBILE_ERROR, normalizeIndianMobile } from "@/lib/family/phone";
import { findUserIdByPhone, PHONE_IN_USE_ERROR, phoneAuthFor } from "@/lib/family/phone-auth";
import { clientIp, OTP_RATE_LIMIT_ERROR, recordOtpSend } from "@/lib/family/otp-rate-limit";
import { fail, ok, parseJson } from "@/lib/http";

export const dynamic = "force-dynamic";

const schema = z.object({ phone: z.string().max(20) }).strict();

// 019 FR-9: a signed-in guardian adds (or changes) their phone, step 1: send a code to the new number.
// Supabase keeps one phone per account, so a verified new number replaces the old one. A number that
// belongs to another account is refused before anything is sent; accounts are never merged.
export async function POST(req: Request) {
  const session = await requireGuardian();
  if (session instanceof Response) return session;
  const parsed = await parseJson(req, schema);
  if ("response" in parsed) return parsed.response;
  const phone = normalizeIndianMobile(parsed.data.phone);
  if (!phone) return fail(400, MOBILE_ERROR);
  const owner = await findUserIdByPhone(phone);
  if (owner && owner !== session.user.id) return fail(409, PHONE_IN_USE_ERROR);

  if ((await recordOtpSend(phone, clientIp(req))) !== "ok") return fail(429, OTP_RATE_LIMIT_ERROR);

  const result = await phoneAuthFor(phone).sendPhoneChangeCode(session.user.id, phone);
  if (result.ok) return ok({ sent: true });
  if (result.reason === "phone_in_use") return fail(409, PHONE_IN_USE_ERROR);
  if (result.reason === "rate_limited") return fail(429, OTP_RATE_LIMIT_ERROR);
  return fail(502, "Could not send the code. Please try again.");
}
