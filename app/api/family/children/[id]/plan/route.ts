import { requireChildGuardian, requireGuardian } from "@/lib/authz";
import { ok } from "@/lib/http";
import { getGuardianPlans } from "@/lib/iep";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 025 FR-6: the latest published plan per organisation, with live progress values. Published content only (NFR-1).
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireGuardian();
  if (session instanceof Response) return session;
  const { id } = await params;
  const access = await requireChildGuardian(id, session);
  if (access instanceof Response) return access;
  return ok({ plans: await getGuardianPlans(access.child.id) });
}
