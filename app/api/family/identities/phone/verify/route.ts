import { z } from "zod";
import { audit } from "@/lib/audit";
import { requireGuardian } from "@/lib/authz";
import { isOtpCode, MOBILE_ERROR, normalizeIndianMobile, OTP_CODE_ERROR, phoneLast4 } from "@/lib/family/phone";
import { findUserIdByPhone, PHONE_IN_USE_ERROR, phoneAuthFor, WRONG_CODE_ERROR } from "@/lib/family/phone-auth";
import { fail, ok, parseJson } from "@/lib/http";

export const dynamic = "force-dynamic";

const schema = z.object({ phone: z.string().max(20), code: z.string().max(10) }).strict();

// 019 FR-9 step 2: confirm the code; the number is added to the signed-in guardian's own account only.
export async function POST(req: Request) {
  const session = await requireGuardian();
  if (session instanceof Response) return session;
  const parsed = await parseJson(req, schema);
  if ("response" in parsed) return parsed.response;
  const phone = normalizeIndianMobile(parsed.data.phone);
  if (!phone) return fail(400, MOBILE_ERROR);
  if (!isOtpCode(parsed.data.code)) return fail(400, OTP_CODE_ERROR);

  const owner = await findUserIdByPhone(phone);
  if (owner && owner !== session.user.id) return fail(409, PHONE_IN_USE_ERROR);

  const result = await phoneAuthFor(phone).verifyPhoneChangeCode(session.user.id, phone, parsed.data.code);
  if (!result.ok) {
    if (result.reason === "invalid_code") return fail(400, WRONG_CODE_ERROR);
    if (result.reason === "phone_in_use") return fail(409, PHONE_IN_USE_ERROR);
    return fail(502, "Could not add this number. Please try again.");
  }

  await audit({
    actorUserId: session.user.id,
    action: "guardian.identity_linked",
    entity: "user",
    entityId: session.user.id,
    details: { provider: "phone", phone_last4: phoneLast4(phone) },
  });
  return ok({ linked: "phone" });
}
