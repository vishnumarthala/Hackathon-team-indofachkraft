import { NextResponse } from "next/server";
import { fail, fieldErrors } from "@/lib/http";
import { isInIndia, OUTSIDE_AREA_ERROR } from "@/lib/geo/constants";
import { parseSearchQuery } from "@/lib/geo/params";
import { clientIp, directorySearchLimiter } from "@/lib/geo/rate-limit";
import { searchProviders } from "@/lib/geo/search";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Public (lib/auth-access.ts). Returns only verified + listed profiles (search_providers). The coordinates in
// the query are used for this request only: never stored, never logged (D-3).
export async function GET(req: Request) {
  if (!directorySearchLimiter.allow(clientIp(req))) {
    return NextResponse.json({ error: "Too many requests. Try again in a minute." }, { status: 429, headers: { "Retry-After": "60" } });
  }

  const parsed = parseSearchQuery(new URL(req.url).searchParams);
  if (!parsed.success) return fail(400, "Invalid request", fieldErrors(parsed.error));
  const query = parsed.data;
  if (query.lat === undefined || query.lng === undefined) {
    return fail(400, "Invalid request", { lat: "lat and lng are required" });
  }
  if (!isInIndia(query.lat, query.lng)) return fail(422, OUTSIDE_AREA_ERROR);

  const page = await searchProviders({
    lat: query.lat,
    lng: query.lng,
    radiusKm: query.radius_km,
    type: query.type,
    language: query.language,
    mode: query.mode,
    page: query.page,
  });
  return NextResponse.json(page, { headers: { "Cache-Control": "public, s-maxage=60" } });
}
