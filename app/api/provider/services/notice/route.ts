import { requireProviderApi } from "@/lib/authz";
import { ok } from "@/lib/http";
import { pg } from "@/lib/pg";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 045 FR-2: dismiss the one-time "Pay at clinic was retired" notice on the provider's own profiles.
export async function POST() {
  const g = await requireProviderApi();
  if ("response" in g) return g.response;
  const sql = await pg();
  const rows = await sql`
    update public.provider_profiles set at_clinic_notice_dismissed_at = now()
    where user_id = ${g.actor.user.id} and at_clinic_notice_dismissed_at is null returning id`;
  return ok({ dismissed: rows.length });
}
