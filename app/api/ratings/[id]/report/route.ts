import { ok, parseJson } from "@/lib/http";
import { requireRatingProvider } from "@/lib/ratings/authz";
import { RatingReportSchema } from "@/lib/ratings/schemas";
import { reportRating, withRatingErrors } from "@/lib/ratings/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 036 FR-6 `Report a rating`: the rated provider (profile owner, or owner/admin of the appointment's organisation)
// sends it to the admin queue (`pending_review`, hidden from the profile). Other ids 404.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireRatingProvider(id);
  if ("response" in gate) return gate.response;
  const parsed = await parseJson(req, RatingReportSchema);
  if ("response" in parsed) return parsed.response;
  const result = await withRatingErrors(() => reportRating(id, gate.actor, parsed.data.reason));
  if ("response" in result) return result.response;
  return ok({ rating: { id: result.data.id, status: result.data.status } });
}
