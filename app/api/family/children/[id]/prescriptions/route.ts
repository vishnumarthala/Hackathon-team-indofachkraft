import { requireChildGuardian, requireGuardian } from "@/lib/authz";
import { ok } from "@/lib/http";
import { listGuardianPrescriptions } from "@/lib/rx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 039 FR-5: the child's signed prescriptions as published to guardians (cancelled ones included, marked `void`).
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireGuardian();
  if (session instanceof Response) return session;
  const { id } = await params;
  const access = await requireChildGuardian(id, session);
  if (access instanceof Response) return access;
  const prescriptions = await listGuardianPrescriptions(access.child.id);
  return ok({ prescriptions: prescriptions.map((p) => ({ ...p, pdf_url: p.status === "signed" ? `/api/family/prescriptions/${p.id}/pdf` : null })) });
}
