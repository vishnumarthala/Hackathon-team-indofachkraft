import { NextResponse } from "next/server";
import { audit } from "@/lib/audit";
import { requirePlatformAdminApi } from "@/lib/authz";
import { isUuid } from "@/lib/cases/validation";
import { fail } from "@/lib/http";
import { certificateSignedUrl } from "@/lib/providers/verification";

export const dynamic = "force-dynamic";

// Certificates are only reachable through this platform-admin route: a 60-second signed URL.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePlatformAdminApi();
  if ("response" in gate) return gate.response;
  const { id } = await params;
  if (!isUuid(id)) return fail(404, "Certificate not found");

  const url = await certificateSignedUrl(id);
  if (!url) return fail(404, "Certificate not found");
  await audit({
    actor: "system",
    actorUserId: gate.actor.user.id,
    action: "provider.certificate_viewed",
    entity: "credential_submission",
    entityId: id,
  });
  const res = NextResponse.redirect(url, 302);
  res.headers.set("Cache-Control", "no-store");
  return res;
}
