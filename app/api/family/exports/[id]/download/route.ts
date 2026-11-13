import { NextResponse } from "next/server";
import { auditActorOf, auditFailure } from "@/lib/audit";
import { requireGuardian } from "@/lib/authz";
import { isUuid } from "@/lib/cases/validation";
import { fail } from "@/lib/http";
import { exportDownloadUrl } from "@/lib/privacy/export";

export const dynamic = "force-dynamic";

// 041 FR-7: 302 to a 10-minute signed URL. Only the requesting guardian, while linked; everyone else 404.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireGuardian();
  if (session instanceof Response) return session;
  const { id } = await params;
  if (!isUuid(id)) return fail(404, "Export not found");
  let result: Awaited<ReturnType<typeof exportDownloadUrl>>;
  try {
    result = await exportDownloadUrl(id, session.user.id, auditActorOf(session.user, "guardian"));
  } catch (err) {
    return auditFailure(err);
  }
  if (!result.ok) return fail(result.status, result.error);
  return NextResponse.redirect(result.url, { status: 302, headers: { "Cache-Control": "no-store" } });
}
