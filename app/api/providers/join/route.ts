import { audit } from "@/lib/audit";
import { fail, ok, parseJson } from "@/lib/http";
import { allowJoin, createProviderAccount } from "@/lib/providers/accounts";
import { JoinSchema } from "@/lib/providers/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function clientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || req.headers.get("x-real-ip") || "unknown";
}

// Public: creates the email/password account for /join. The provider profile and role are created by
// POST /api/providers/register once the user is signed in.
export async function POST(req: Request) {
  if (!allowJoin(clientIp(req))) return fail(429, "Too many sign-ups. Try again later.");
  const parsed = await parseJson(req, JoinSchema);
  if ("response" in parsed) return parsed.response;

  const result = await createProviderAccount(parsed.data);
  if (!result.ok) return fail(result.status, result.error);
  await audit({
    actor: "system",
    action: "provider.account_created",
    entity: "auth_user",
    details: { provider_type: parsed.data.provider_type, confirm_email: result.confirmEmail },
  });
  return ok({ confirm_email: result.confirmEmail }, 201);
}
