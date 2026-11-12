import { z } from "zod";
import { audit } from "@/lib/audit";
import { requireReportAccess } from "@/lib/authz";
import { fail, ok, parseJson } from "@/lib/http";
import { getReport, updateDraftReport } from "@/lib/queries/reports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ReportPatchSchema = z
  .object({
    content_md: z
      .string({ error: "Report text must be text" })
      .min(1, "Report text is required")
      .max(50_000, "Report text must be at most 50000 characters")
      .optional(),
    status: z.literal("final", { error: "Status can only be final" }).optional(),
  })
  .strict()
  .refine((b) => b.content_md !== undefined || b.status !== undefined, { message: "Nothing to update" });

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const denied = await requireReportAccess(id);
  if (denied) return denied;
  const report = await getReport(id);
  if (!report) return fail(404, "Report not found");
  if (report.kind !== "assessment") return fail(422, "Only assessment reports can be edited here");
  if (report.status === "final") return fail(409, "Report is final");

  const parsed = await parseJson(req, ReportPatchSchema);
  if ("response" in parsed) return parsed.response;
  const patch = parsed.data;

  const updated = await updateDraftReport(id, patch);
  if (!updated) return fail(409, "Report is final");

  if (patch.content_md !== undefined) {
    await audit({
      caseId: report.case_id,
      actor: "therapist",
      action: "report.edited",
      entity: "report",
      entityId: id,
      details: { chars: patch.content_md.length },
    });
  }
  if (patch.status === "final") {
    await audit({ caseId: report.case_id, actor: "therapist", action: "report.finalized", entity: "report", entityId: id });
  }
  return ok({ report: updated });
}
