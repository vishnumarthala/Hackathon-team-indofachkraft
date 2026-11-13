import { audit } from "@/lib/audit";
import { requireReportAccess } from "@/lib/authz";
import { assertConsentOrAbort, childIdForCase, consentRequired, requireConsent } from "@/lib/consent";
import { NoVoiceError, synthesize, voiceIdFor } from "@/lib/elevenlabs/tts";
import { sendEmail } from "@/lib/email";
import { env } from "@/lib/env";
import { generateJson } from "@/lib/gemini";
import { fail, ok } from "@/lib/http";
import {
  AUDIO_LINK_TTL_SEC,
  VOICE_NOTE_FAILED,
  audioObjectPath,
  buildParentSummaryPrompt,
  emailSubject,
  emailText,
  looksLikeScore,
  parentSummarySystemPrompt,
  type EmailStatus,
} from "@/lib/parentNote";
import { getCase } from "@/lib/queries/cases";
import { removeAudio, saveParentSummary, setEmailStatus, signedAudioUrl, uploadAudio } from "@/lib/queries/parentNote";
import { getReport } from "@/lib/queries/reports";
import { ParentSummarySchema, type ParentSummary } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const denied = await requireReportAccess(id);
  if (denied) return denied;
  const assessment = await getReport(id);
  if (!assessment) return fail(404, "Report not found");
  if (assessment.kind !== "assessment" || assessment.status !== "final" || !assessment.recording_id) {
    return fail(422, "Finalize the report first");
  }
  const caseRow = await getCase(assessment.case_id);
  if (!caseRow) return fail(404, "Report not found");
  // 020 FR-7: the voice note needs the guardian's ai_voice_note consent (re-checked before TTS).
  const childId = await childIdForCase(caseRow.id);
  const blocked = await requireConsent(childId, "ai_voice_note");
  if (blocked) return blocked;
  const demo = env.DEMO_MODE;

  const failed = async (stage: string, err: unknown) => {
    await audit({
      caseId: caseRow.id,
      actor: "ai",
      action: "parent_note.failed",
      entity: "report",
      entityId: id,
      details: { stage, error: messageOf(err) },
    });
    return fail(502, VOICE_NOTE_FAILED);
  };

  // Check the voice before spending a model call (FR-3: 422 when none is configured).
  if (!demo) {
    try {
      voiceIdFor(caseRow.language);
    } catch (err) {
      if (err instanceof NoVoiceError) return fail(422, err.message);
      throw err;
    }
  }

  let summary: ParentSummary;
  try {
    summary = await generateJson({
      task: "parent-summary",
      system: parentSummarySystemPrompt(),
      prompt: buildParentSummaryPrompt({
        language: caseRow.language,
        parentAlias: caseRow.parent_alias,
        childAlias: caseRow.child_alias,
        reportMd: assessment.content_md,
      }),
      schema: ParentSummarySchema,
    });
  } catch (err) {
    return failed("gemini", err);
  }
  if (summary.language !== caseRow.language) return failed("gemini", new Error(`Summary language ${summary.language} is not ${caseRow.language}`));
  if (looksLikeScore(summary.text)) return failed("gemini", new Error("Summary contains score-like text"));

  if (!(await assertConsentOrAbort(childId, "ai_voice_note", { stage: "before_tts", caseId: caseRow.id }))) {
    return consentRequired(childId, "ai_voice_note");
  }

  let audioPath: string | null = null;
  if (!demo) {
    let audio: Buffer;
    try {
      audio = await synthesize({ text: summary.text, language: caseRow.language });
    } catch (err) {
      if (err instanceof NoVoiceError) return fail(422, err.message);
      return failed("tts", err);
    }
    const path = audioObjectPath(caseRow.id, assessment.id);
    try {
      await uploadAudio(path, audio);
    } catch (err) {
      await audit({ caseId: caseRow.id, actor: "system", action: "parent_note.failed", entity: "report", entityId: id, details: { stage: "upload", error: messageOf(err) } });
      return fail(500, "Could not save the voice note");
    }
    audioPath = path;
  }

  let report;
  try {
    report = await saveParentSummary({
      caseId: caseRow.id,
      recordingId: assessment.recording_id,
      content: summary,
      contentMd: summary.text,
      audioPath,
    });
  } catch (err) {
    if (audioPath) await removeAudio(audioPath);
    await audit({ caseId: caseRow.id, actor: "system", action: "parent_note.failed", entity: "report", entityId: id, details: { stage: "save", error: messageOf(err) } });
    return fail(500, "Could not save the voice note");
  }

  let emailStatus: EmailStatus;
  let emailError: string | null = null;
  if (!caseRow.parent_email) {
    emailStatus = "no_email";
  } else {
    try {
      const link = audioPath ? await signedAudioUrl(audioPath, AUDIO_LINK_TTL_SEC) : null;
      if (audioPath && !link) throw new Error("Could not create the audio link");
      const result = await sendEmail({
        to: caseRow.parent_email,
        subject: emailSubject(caseRow.therapist_name, caseRow.child_alias),
        text: emailText(summary.text, link),
        caseId: caseRow.id,
      });
      emailStatus = result.delivered ? "sent" : "demo";
    } catch (err) {
      emailStatus = "failed";
      emailError = messageOf(err);
    }
  }

  try {
    await setEmailStatus(report.id, emailStatus);
    report = { ...report, email_status: emailStatus };
  } catch (err) {
    console.error(`parent note email status not saved: ${messageOf(err)}`);
  }

  await audit({
    caseId: caseRow.id,
    action: emailStatus === "failed" ? "parent_note.email_failed" : "parent_note.sent",
    entity: "report",
    entityId: report.id,
    details: {
      assessment_report_id: id,
      language: summary.language,
      audio: audioPath !== null,
      emailed: emailStatus === "sent",
      email_status: emailStatus,
      ...(emailError ? { error: emailError } : {}),
    },
  });

  return ok({ report, emailed: emailStatus === "sent", email_status: emailStatus });
}
