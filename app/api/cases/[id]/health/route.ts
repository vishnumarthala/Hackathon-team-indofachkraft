import { requireCaseAccess } from "@/lib/authz";
import { fail, ok } from "@/lib/http";
import { getHealthProfileForCase } from "@/lib/queries/health";

export const dynamic = "force-dynamic";

// 021 FR-5 (rule 2): providers read the health profile of the case's child only through a case of their own
// organisation they can access (017/022 requireCaseAccess). Read only; editing is the guardian's.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const denied = await requireCaseAccess(id);
  if (denied) return denied;
  const profile = await getHealthProfileForCase(id);
  if (!profile) return fail(404, "No health profile yet");
  const res = ok({ profile, updated_at: profile.updated_at });
  res.headers.set("Cache-Control", "private, no-store");
  return res;
}
