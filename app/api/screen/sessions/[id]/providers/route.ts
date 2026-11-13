import { NextResponse } from "next/server";
import { z } from "zod";
import { fail, fieldErrors } from "@/lib/http";
import { isInIndia, OUTSIDE_AREA_ERROR } from "@/lib/geo/constants";
import { normalizeParams } from "@/lib/geo/params";
import { findMatches } from "@/lib/screen/matches";
import { allowScreenMatches } from "@/lib/screen/rate-limit";
import { getSessionView } from "@/lib/screen/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const QuerySchema = z
  .object({
    lat: z.coerce.number({ error: "lat must be a number" }).min(-90).max(90).optional(),
    lng: z.coerce.number({ error: "lng must be a number" }).min(-180).max(180).optional(),
  })
  .refine((v) => (v.lat === undefined) === (v.lng === undefined), { error: "lat and lng go together", path: ["lat"] });

export const NO_RESULT = "Finish the check-in first";

// Ticket 048 FR-10: public, keyed by the (unguessable) check-in id like the other check-in endpoints. Only a finished
// check-in without a red flag gets providers (FR-8: never after a red flag); saved check-ins answer 404. The provider
// types come from the server-side recommendation, not from the browser. The optional location is used for this
// request only (rounded to ~100 m, never stored or logged, 029 D-3); default central Hyderabad.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!allowScreenMatches(req)) {
    return NextResponse.json({ error: "Too many requests. Try again in a minute." }, { status: 429, headers: { "Retry-After": "60" } });
  }
  const parsed = QuerySchema.safeParse(normalizeParams(new URL(req.url).searchParams));
  if (!parsed.success) return fail(400, "Invalid request", fieldErrors(parsed.error));
  const { lat, lng } = parsed.data;
  if (lat !== undefined && lng !== undefined && !isInIndia(lat, lng)) return fail(422, OUTSIDE_AREA_ERROR);

  const { id } = await params;
  const found = await getSessionView(id);
  if (!found.ok) return fail(found.status, found.error, found.details);
  const recommendation = found.view.result?.recommendation;
  if (found.view.status !== "finished" || !recommendation) return fail(409, NO_RESULT);

  const matches = await findMatches({
    types: recommendation.types,
    origin: lat !== undefined && lng !== undefined ? { lat, lng } : null,
  });
  return NextResponse.json(matches, { headers: { "Cache-Control": "no-store" } });
}
