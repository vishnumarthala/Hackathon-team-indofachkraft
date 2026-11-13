import { NextResponse } from "next/server";
import { isUuid } from "@/lib/cases/validation";
import { getBookableProfile, getService, getSlots } from "@/lib/booking/store";
import { SlotsQuerySchema } from "@/lib/booking/schemas";
import { slotsLimiter } from "@/lib/booking/rate-limit";
import { clientIp } from "@/lib/geo/rate-limit";
import { fail, fieldErrors } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// FR-2 (public, also for 034's voice agent): free slots of an active service of a verified + listed profile,
// as UTC ISO strings. `from` is a local date in the service's time zone (default today), `days` 1-14 (default 7).
export async function GET(req: Request, { params }: { params: Promise<{ profileId: string }> }) {
  if (!slotsLimiter.allow(clientIp(req))) {
    return NextResponse.json({ error: "Too many requests. Try again in a minute." }, { status: 429, headers: { "Retry-After": "60" } });
  }
  const { profileId } = await params;
  const parsed = SlotsQuerySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return fail(400, "Invalid request", fieldErrors(parsed.error));
  if (!isUuid(profileId)) return fail(404, "Provider not found");
  const profile = await getBookableProfile(profileId);
  if (!profile) return fail(404, "Provider not found");
  const service = await getService(parsed.data.service_id);
  if (!service || !service.active || service.provider_profile_id !== profile.id) return fail(404, "Service not found");

  const { from, slots } = await getSlots(service, { from: parsed.data.from, days: parsed.data.days });
  return NextResponse.json(
    { slots, from, days: parsed.data.days, time_zone: service.time_zone, duration_min: service.duration_min },
    { headers: { "Cache-Control": "no-store" } },
  );
}
