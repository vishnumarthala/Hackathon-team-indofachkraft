import Link from "next/link";
import { notFound } from "next/navigation";
import { ScribeReview } from "@/components/scribe/ScribeReview";
import { ReviewScreen } from "@/components/session/ReviewScreen";
import { getSessionReview } from "@/lib/queries/sessions";
import { needsReextraction } from "@/lib/speakers";
import { requireCasePage } from "@/lib/authz";
import { getScribeReview, recordingTemplate } from "@/lib/scribe/queries";
import { isNoteTemplate } from "@/lib/scribe/templates";

export const dynamic = "force-dynamic";

export default async function SessionReviewPage({
  params,
}: {
  params: Promise<{ id: string; recordingId: string }>;
}) {
  const { id, recordingId } = await params;
  const actor = await requireCasePage(id);

  // 038: AI scribe sessions (any template but the ISAA one) get the scribe review.
  if (isNoteTemplate(await recordingTemplate(id, recordingId))) {
    const scribe = await getScribeReview(id, recordingId, actor.user.id);
    if (!scribe) notFound();
    const { recording, note, suggestions, rx, audioUrl, viewerCanPrescribe } = scribe;
    return (
      <ScribeReview
        caseId={id}
        recordingId={recording.id}
        sessionNumber={recording.session_number}
        template={recording.template}
        status={recording.status}
        error={recording.error}
        audioUrl={audioUrl}
        segmentStarts={Object.fromEntries((recording.segments ?? []).map((s) => [s.id, s.start_sec]))}
        note={note ? { id: note.id, status: note.status, content_md: note.content_md, published: note.published } : null}
        suggestions={suggestions}
        rx={viewerCanPrescribe && rx ? { id: rx.id, content: rx.content } : null}
      />
    );
  }

  const review = await getSessionReview(id, recordingId);
  if (!review) notFound();

  const { caseRow, recording, facts, audioUrl } = review;

  if (recording.status !== "extracted") {
    return (
      <p className="text-slate-800">
        This session is {recording.status}. Process it from the{" "}
        <Link href={`/cases/${id}/sessions/new`} className="underline">
          New session page
        </Link>
        .
      </p>
    );
  }

  return (
    <ReviewScreen
      recordingId={recording.id}
      sessionNumber={recording.session_number}
      audioUrl={audioUrl}
      segments={recording.segments ?? []}
      facts={facts}
      extractionRedFlags={recording.red_flags ?? []}
      facpScore={caseRow.facp_score ?? null}
      needsReextraction={await needsReextraction(recording.id)}
    />
  );
}
