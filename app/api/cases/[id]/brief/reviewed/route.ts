import { audit } from "@/lib/audit";
import { requireApiUser } from "@/lib/auth";
import { fail, ok } from "@/lib/http";
import { markBriefReviewed } from "@/lib/queries/intake";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const unauthorized = await requireApiUser();
  if (unauthorized) return unauthorized;

  const { id } = await params;
  const report = await markBriefReviewed(id);
  if (!report) return fail(404, "No brief for this case");

  await audit({
    caseId: id,
    actor: "therapist",
    action: "brief.reviewed",
    entity: "report",
    entityId: report.id,
  });
  return ok({ report });
}
