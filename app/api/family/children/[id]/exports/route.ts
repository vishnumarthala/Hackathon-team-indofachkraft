import { auditActorOf, auditFailure } from "@/lib/audit";
import { requireChildGuardian, requireGuardian } from "@/lib/authz";
import { fail, ok } from "@/lib/http";
import { listExports, requestExport } from "@/lib/privacy/export";
import { runPrivacyJobsSoon } from "@/lib/privacy/jobs";

export const dynamic = "force-dynamic";

function exportJson(row: Awaited<ReturnType<typeof listExports>>[number]) {
  return {
    id: row.id,
    status: row.status,
    created_at: row.created_at,
    completed_at: row.completed_at,
    expires_at: row.expires_at,
    size_bytes: row.size_bytes === null ? null : Number(row.size_bytes),
    download_url: row.status === "ready" ? `/api/family/exports/${row.id}/download` : null,
  };
}

// 041 FR-7: the requesting guardian's own exports of this child.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireGuardian();
  if (session instanceof Response) return session;
  const access = await requireChildGuardian((await params).id, session);
  if (access instanceof Response) return access;
  return ok({ exports: (await listExports(access.child.id, session.user.id)).map(exportJson) });
}

// 041 FR-7: 202 { export_id }; one running per child and 3 per day -> 429. The body is ignored (nothing to choose).
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireGuardian();
  if (session instanceof Response) return session;
  const access = await requireChildGuardian((await params).id, session);
  if (access instanceof Response) return access;
  let result: Awaited<ReturnType<typeof requestExport>>;
  try {
    result = await requestExport(access.child.id, session.user.id, auditActorOf(session.user, "guardian"));
  } catch (err) {
    return auditFailure(err);
  }
  if (!result.ok) return fail(result.status, result.error);
  runPrivacyJobsSoon({ exportIds: [result.exportId] });
  return ok({ export_id: result.exportId }, 202);
}
