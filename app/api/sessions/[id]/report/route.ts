import { audit } from "@/lib/audit";
import { requireRecordingAccess } from "@/lib/authz";
import { assertConsentOrAbort, childIdForCase, consentRequired, requireConsent } from "@/lib/consent";
import { generateJson } from "@/lib/gemini";
import { fail, ok } from "@/lib/http";
import { getCase } from "@/lib/queries/cases";
import { getRecording } from "@/lib/queries/recordings";
import { getAssessmentReport, getBriefSummary, listIsaaFacts, saveAssessmentDraft } from "@/lib/queries/reports";
import { buildReportPrompt, computeReport, decidedFacts, filterDraft, reportSystemPrompt } from "@/lib/report/draft";
import { ReportDraftSchema, type ReportDraft } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const REPORT_FINAL = "Report is final";
const CONFIRM_FIRST = "Confirm at least one ISAA item first";
const GENERATION_FAILED = "Report could not be generated";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const denied = await requireRecordingAccess(id);
  if (denied) return denied;
  const recording = await getRecording(id);
  if (!recording || recording.kind !== "session") return fail(404, "Session not found");
  // 020 FR-7: report drafting is AI analysis (ai_extraction).
  const childId = await childIdForCase(recording.case_id);
  const blocked = await requireConsent(childId, "ai_extraction");
  if (blocked) return blocked;

  const facts = decidedFacts(await listIsaaFacts(id));
  if (facts.length === 0) return fail(422, CONFIRM_FIRST);

  const existing = await getAssessmentReport(id);
  if (existing?.status === "final") return fail(409, REPORT_FINAL);

  const caseRow = await getCase(recording.case_id);
  if (!caseRow) return fail(404, "Session not found");
  const sessionNumber = recording.session_number ?? 1;
  const briefSummary = await getBriefSummary(caseRow.id);

  if (!(await assertConsentOrAbort(childId, "ai_extraction", { stage: "before_gemini_report", caseId: caseRow.id, recordingId: id }))) {
    return consentRequired(childId, "ai_extraction");
  }

  let output: ReportDraft;
  try {
    output = await generateJson({
      task: "report",
      system: reportSystemPrompt(),
      prompt: buildReportPrompt({ caseRow, sessionNumber, facts, briefSummary }),
      schema: ReportDraftSchema,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await audit({
      caseId: caseRow.id,
      actor: "ai",
      action: "report.draft_failed",
      entity: "recording",
      entityId: id,
      details: { error: message },
    });
    return fail(502, GENERATION_FAILED);
  }

  const { draft, rejected } = filterDraft(output, facts);
  const { score, content_md } = computeReport({
    caseRow,
    sessionNumber,
    date: recording.created_at.slice(0, 10),
    facts,
    draft,
  });

  const saved = await saveAssessmentDraft({ caseId: caseRow.id, recordingId: id }, { content: draft, content_md });
  if (!saved.ok) return fail(409, REPORT_FINAL);

  await audit({
    caseId: caseRow.id,
    actor: "ai",
    action: "report.drafted",
    entity: "report",
    entityId: saved.report.id,
    details: { recording_id: id, confirmed_items: facts.length, provisional: score.total === null, rejected },
  });

  return ok({ report: saved.report });
}
