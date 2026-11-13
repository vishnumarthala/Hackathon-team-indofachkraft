import { NextResponse } from "next/server";
import { audit } from "@/lib/audit";
import { requireCaseActor } from "@/lib/authz";
import { isUuid } from "@/lib/cases/validation";
import { signedScanUrl } from "@/lib/consent/paper";
import { supabaseAdmin } from "@/lib/db";
import { fail } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 020 FR-18a: the signed form is only reachable through a 60-second signed URL, for members of the org of
// the case it was recorded on.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string; recordId: string }> }) {
  const { id, recordId } = await params;
  const gate = await requireCaseActor(id);
  if ("response" in gate) return gate.response;
  if (!isUuid(recordId)) return fail(404, "Not found");
  const { data, error } = await supabaseAdmin()
    .from("consent_records")
    .select("id, case_id, paper_form_path")
    .eq("id", recordId)
    .maybeSingle();
  if (error) return fail(503, "Could not load the form");
  const row = data as { id: string; case_id: string | null; paper_form_path: string | null } | null;
  if (!row || row.case_id !== id || !row.paper_form_path) return fail(404, "Not found");
  const url = await signedScanUrl(row.paper_form_path);
  if (!url) return fail(503, "Could not load the form");
  await audit({
    caseId: id,
    actorUserId: gate.actor.user.id,
    action: "consent.scan_viewed",
    entity: "consent_record",
    entityId: row.id,
  });
  return NextResponse.redirect(url, 302);
}
