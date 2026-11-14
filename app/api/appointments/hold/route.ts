import { NextResponse } from "next/server";
import { getAuthenticatedUser, getUserRole } from "@/lib/auth";
import { withBookingErrors } from "@/lib/booking/errors";
import { checkHoldPreconditions } from "@/lib/booking/hooks";
import { HoldSchema } from "@/lib/booking/schemas";
import { bookingSessionCookie, ensureBookingSession } from "@/lib/booking/session";
import { getBookableProfile, getService, holdSlot, type HoldOwner } from "@/lib/booking/store";
import { holdLimiter } from "@/lib/booking/rate-limit";
import { clientIp } from "@/lib/geo/rate-limit";
import { fail, fieldErrors } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// FR-4 hold: 201 { appointment_id, hold_expires_at }; the same idempotency_key from the same owner -> 200 with the
// same appointment; 409 slot taken. Owner = the signed-in guardian, else an anonymous booking session (cookie).
export async function POST(req: Request) {
  // Anonymous visitors can hold too (public in lib/auth-access.ts): cap holds per IP. One active hold per owner is SQL.
  if (!holdLimiter.allow(clientIp(req))) {
    return NextResponse.json({ error: "Too many requests. Try again later." }, { status: 429, headers: { "Retry-After": "600" } });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail(400, "Invalid request", { body: "Body must be JSON" });
  }
  const parsed = HoldSchema.safeParse(body);
  if (!parsed.success) return fail(400, "Invalid request", fieldErrors(parsed.error));

  const user = await getAuthenticatedUser();
  if (user && (await getUserRole(user.id)) !== "guardian") return fail(403, "Only family accounts can book appointments.");

  const service = await getService(parsed.data.service_id);
  // 046 FR-2: paid services of organisations without an active payout account are hidden from booking.
  const profile = service?.active && service.payouts_ready ? await getBookableProfile(service.provider_profile_id) : null;
  if (!service || !profile) return fail(404, "Service not found");

  const blocked = await checkHoldPreconditions({ profile, service, userId: user?.id ?? null, body: body as Record<string, unknown> });
  if (blocked) return NextResponse.json({ error: blocked.error, code: blocked.code }, { status: blocked.status });

  const session = user ? null : await ensureBookingSession();
  const owner: HoldOwner = user ? { userId: user.id } : { sessionHash: (session as { hash: string }).hash };
  const result = await withBookingErrors(() => holdSlot(parsed.data, owner));
  if ("response" in result) return result.response;

  const { appointment_id, hold_expires_at, status, replay } = result.data;
  const res = NextResponse.json({ appointment_id, hold_expires_at, status }, { status: replay ? 200 : 201 });
  if (session?.created) res.cookies.set(bookingSessionCookie(session.id));
  return res;
}
