import { z } from "zod";
import { getUserRole } from "@/lib/auth";
import { postSignInPath } from "@/lib/auth-access";
import { isOtpCode, MOBILE_ERROR, normalizeIndianMobile, OTP_CODE_ERROR } from "@/lib/family/phone";
import { phoneAuthFor, WRONG_CODE_ERROR } from "@/lib/family/phone-auth";
import { fail, ok, parseJson } from "@/lib/http";

export const dynamic = "force-dynamic";

const schema = z.object({
  phone: z.string().max(20),
  code: z.string().max(10),
  next: z.string().max(500).optional(),
});

// Public (019 FR-1/FR-3): verify the code, set the session cookies and tell the client where to go.
export async function POST(req: Request) {
  const parsed = await parseJson(req, schema);
  if ("response" in parsed) return parsed.response;
  const phone = normalizeIndianMobile(parsed.data.phone);
  if (!phone) return fail(400, MOBILE_ERROR);
  if (!isOtpCode(parsed.data.code)) return fail(400, OTP_CODE_ERROR);

  const result = await phoneAuthFor(phone).verifySignInCode(phone, parsed.data.code);
  if (!result.ok) {
    if (result.reason === "invalid_code") return fail(400, WRONG_CODE_ERROR);
    return fail(502, "Could not sign you in. Please try again.");
  }
  const role = await getUserRole(result.userId);
  return ok({ redirect: postSignInPath(role, parsed.data.next) });
}
