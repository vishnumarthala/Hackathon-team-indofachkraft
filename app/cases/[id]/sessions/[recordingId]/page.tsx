import Link from "next/link";
import { notFound } from "next/navigation";
import { ReviewScreen } from "@/components/session/ReviewScreen";
import { getSessionReview } from "@/lib/queries/sessions";

export const dynamic = "force-dynamic";

export default async function SessionReviewPage({
  params,
}: {
  params: Promise<{ id: string; recordingId: string }>;
}) {
  const { id, recordingId } = await params;
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
    />
  );
}
