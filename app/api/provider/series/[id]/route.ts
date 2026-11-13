import { requireProviderApi } from "@/lib/authz";
import { isUuid } from "@/lib/cases/validation";
import { getManageableSeries, listOccurrences } from "@/lib/booking/series";
import { fail, ok } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 043: one series with its occurrences, for the staff who manage it (FR-2). Everything else -> 404.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireProviderApi();
  if ("response" in gate) return gate.response;
  const series = isUuid(id) ? await getManageableSeries(id, gate.actor.user.id) : null;
  if (!series) return fail(404, "Not found");
  return ok({ series, occurrences: await listOccurrences([id]) });
}
