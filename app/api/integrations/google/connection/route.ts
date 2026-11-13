import { requireProviderContext } from "@/lib/booking/authz";
import { isUuid } from "@/lib/cases/validation";
import { googleConnectAvailable } from "@/lib/google/client";
import { getConnectionView } from "@/lib/google/connections";
import { fail, ok } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 037: the caller's own Google Calendar connection (email, scopes, status, dates - never the token, NFR-1).
// `?profile_id=` other than the caller's own profile -> 404 (E-3).
export async function GET(req: Request) {
  const gate = await requireProviderContext();
  if ("response" in gate) return gate.response;
  const requested = new URL(req.url).searchParams.get("profile_id");
  if (requested !== null && (!isUuid(requested) || requested !== gate.ctx.profile.id)) return fail(404, "Profile not found");
  const connection = await getConnectionView(gate.ctx.profile.id);
  return ok({ available: googleConnectAvailable(), connection });
}
