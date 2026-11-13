import { z } from "zod";
import { auditFailure, AuditWriteError } from "@/lib/audit";
import { requireRecordingActor } from "@/lib/authz";
import { requireCaseConsent } from "@/lib/consent";
import { fail, ok, parseJson } from "@/lib/http";
import { getRecording } from "@/lib/queries/recordings";
import { finalizeSessionNote, saveSessionNoteDraft, setSessionNoteSharing } from "@/lib/scribe/notes";
import { getScribeReview } from "@/lib/scribe/queries";
import { runScribe, SCRIBE_MESSAGES, type ScribeOutcome } from "@/lib/scribe/run";
import { isNoteTemplate } from "@/lib/scribe/templates";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** After the case gate: 404 for intake calls, 409 for Child Development (ISAA) sessions. */
async function scribeRecordingProblem(id: string): Promise<Response | null> {
  const recording = await getRecording(id);
  if (!recording || recording.kind === "intake_call") return fail(404, SCRIBE_MESSAGES.notFound);
  if (!isNoteTemplate(recording.template ?? "child_dev_isaa")) return fail(409, SCRIBE_MESSAGES.isaa);
  return null;
}

// 038 FR-4: run the AI scribe -> 200 { session_note_id, goal_suggestions, rx_draft_id? }. Idempotent per recording:
// a re-run replaces drafts only (a final note is kept).
export async function POST(_req: Request, { params }: Params) {
  const { id } = await params;
  const gate = await requireRecordingActor(id);
  if ("response" in gate) return gate.response;
  const problem = await scribeRecordingProblem(id);
  if (problem) return problem;
  // 020: collection-time gate; runScribe re-checks right before each Gemini request.
  const blocked = await requireCaseConsent(gate.caseId, "ai_extraction");
  if (blocked) return blocked;
  let outcome: ScribeOutcome;
  try {
    outcome = await runScribe(id);
  } catch (err) {
    console.error(`scribe could not start for ${id}: ${err instanceof Error ? err.message : String(err)}`);
    return fail(500, "Could not start the AI scribe");
  }
  if (!outcome.ok) return fail(outcome.status, outcome.error, outcome.details);
  return ok(outcome.body);
}

// The scribe outputs of a recording. The Rx draft is only shown to prescribers (039: non-prescribers never see
// prescription features).
export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;
  const gate = await requireRecordingActor(id);
  if ("response" in gate) return gate.response;
  const problem = await scribeRecordingProblem(id);
  if (problem) return problem;
  const review = await getScribeReview(gate.caseId, id, gate.actor.user.id);
  if (!review) return fail(404, SCRIBE_MESSAGES.notFound);
  return ok({
    recording: { id, status: review.recording.status, template: review.recording.template, error: review.recording.error },
    session_note: review.note,
    goal_suggestions: review.suggestions,
    rx_draft: review.viewerCanPrescribe ? review.rx : null,
  });
}

const PatchSchema = z
  .object({
    content_md: z
      .string({ error: "Note text must be text" })
      .trim()
      .min(1, "Note text is required")
      .max(50_000, "Note text must be at most 50000 characters")
      .optional(),
    status: z.literal("final", { error: "Status can only be final" }).optional(),
    visible_to_guardian: z.boolean({ error: "visible_to_guardian must be true or false" }).optional(),
  })
  .strict()
  .refine((b) => b.content_md !== undefined || b.status !== undefined || b.visible_to_guardian !== undefined, {
    message: "Nothing to update",
  });

// 038 FR-5: edit the draft note, `Finalize note` (status final; publishes via 024 publishVersion with
// `visible_to_guardian`, default false) or share / stop sharing a final note (`visible_to_guardian` only).
export async function PATCH(req: Request, { params }: Params) {
  const { id } = await params;
  const gate = await requireRecordingActor(id);
  if ("response" in gate) return gate.response;
  const problem = await scribeRecordingProblem(id);
  if (problem) return problem;
  const parsed = await parseJson(req, PatchSchema);
  if ("response" in parsed) return parsed.response;
  const body = parsed.data;
  const actorUserId = gate.actor.user.id;
  try {
    if (body.status === "final") {
      const result = await finalizeSessionNote({
        recordingId: id,
        contentMd: body.content_md,
        visibleToGuardian: body.visible_to_guardian ?? false,
        actorUserId,
      });
      if (!result.ok) return fail(result.status, result.error);
      return ok(result);
    }
    if (body.content_md !== undefined) {
      if (body.visible_to_guardian !== undefined) return fail(400, "Invalid request", { visible_to_guardian: "Finalize the note first" });
      const result = await saveSessionNoteDraft({ recordingId: id, contentMd: body.content_md, actorUserId });
      if (!result.ok) return fail(result.status, result.error);
      return ok(result);
    }
    const result = await setSessionNoteSharing({ recordingId: id, visibleToGuardian: body.visible_to_guardian as boolean, actorUserId });
    if (!result.ok) return fail(result.status, result.error);
    return ok(result);
  } catch (err) {
    if (err instanceof AuditWriteError) return auditFailure(err);
    console.error(`session note update failed for ${id}: ${err instanceof Error ? err.message : String(err)}`);
    return fail(500, "Could not save the note");
  }
}
