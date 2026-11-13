import { ok, parseJson } from "@/lib/http";
import { requireRatingAdmin } from "@/lib/ratings/authz";
import { RatingModerateSchema } from "@/lib/ratings/schemas";
import { moderateRating, withRatingErrors } from "@/lib/ratings/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 036 FR-6 moderation: platform admins only (403 otherwise). `{ action: "publish" | "hide", note? }` (a note is
// required to hide); audited in the same transaction (`rating.moderated`).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireRatingAdmin(id);
  if ("response" in gate) return gate.response;
  const parsed = await parseJson(req, RatingModerateSchema);
  if ("response" in parsed) return parsed.response;
  const result = await withRatingErrors(() => moderateRating(id, gate.actor, parsed.data));
  if ("response" in result) return result.response;
  return ok({ rating: result.data });
}
