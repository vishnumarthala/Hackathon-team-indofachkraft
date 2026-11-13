import { ok, parseJson } from "@/lib/http";
import { requireRatingGuardian } from "@/lib/ratings/authz";
import { RatingCreateSchema, RatingUpdateSchema } from "@/lib/ratings/schemas";
import { createRating, updateRating, withRatingErrors } from "@/lib/ratings/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 036 FR-3: the booking guardian rates a completed appointment (1-5 stars, optional comment <= 500).
// 201; not eligible 403 `You can rate only your completed appointments`; duplicate 409; names/contact details in
// the comment 422 `Please remove names and contact details from your comment`.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireRatingGuardian(id);
  if ("response" in gate) return gate.response;
  const parsed = await parseJson(req, RatingCreateSchema);
  if ("response" in parsed) return parsed.response;
  const result = await withRatingErrors(() => createRating(id, gate.actor, parsed.data));
  if ("response" in result) return result.response;
  return ok({ rating: result.data }, 201);
}

// Edit within 7 days of rating (403 after; 409 when an admin hid it). Same screening.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireRatingGuardian(id);
  if ("response" in gate) return gate.response;
  const parsed = await parseJson(req, RatingUpdateSchema);
  if ("response" in parsed) return parsed.response;
  const result = await withRatingErrors(() => updateRating(id, gate.actor, parsed.data));
  if ("response" in result) return result.response;
  return ok({ rating: result.data });
}
