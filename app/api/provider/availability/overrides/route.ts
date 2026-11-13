import { audit } from "@/lib/audit";
import { requireProviderContext } from "@/lib/booking/authz";
import { withProviderInput } from "@/lib/booking/provider-routes";
import { OverrideCreateSchema } from "@/lib/booking/schemas";
import { createOverride, listOverrides } from "@/lib/booking/store";
import { addDays, todayIn } from "@/lib/booking/time";
import { ok, parseJson } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// FR-8 date overrides of the caller's own profile: `Block a date` (unavailable, whole day without times) and
// `Add extra hours`. Existing appointments stay booked (the agenda flags them).
export async function GET() {
  const gate = await requireProviderContext();
  if ("response" in gate) return gate.response;
  return ok({ overrides: await listOverrides(gate.ctx.profile.id, addDays(todayIn(gate.ctx.profile.time_zone), -1)) });
}

export async function POST(req: Request) {
  const gate = await requireProviderContext();
  if ("response" in gate) return gate.response;
  const parsed = await parseJson(req, OverrideCreateSchema);
  if ("response" in parsed) return parsed.response;
  const result = await withProviderInput(() => createOverride(gate.ctx, parsed.data));
  if ("response" in result) return result.response;
  await audit({ actorUserId: gate.actor.user.id, action: `booking.override_${parsed.data.kind}`, entity: "availability_override", entityId: result.data.id });
  return ok({ override: result.data }, 201);
}
