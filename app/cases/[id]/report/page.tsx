import { notFound } from "next/navigation";
import { ParentVoiceNote } from "@/components/report/ParentVoiceNote";
import { ReportEditor } from "@/components/report/ReportEditor";
import { SessionSelect } from "@/components/report/SessionSelect";
import { AUDIO_PLAYER_TTL_SEC, noteView } from "@/lib/parentNote";
import { getCase } from "@/lib/queries/cases";
import { getParentSummary, signedAudioUrl } from "@/lib/queries/parentNote";
import { getAssessmentReport, listExtractedSessions, listIsaaFacts } from "@/lib/queries/reports";
import { decidedFacts } from "@/lib/report/draft";

export const dynamic = "force-dynamic";

const CONFIRM_FIRST = "Confirm ISAA items in a session first.";

export default async function ReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { id } = await params;
  const { session } = await searchParams;
  const caseRow = await getCase(id);
  if (!caseRow) notFound();

  const sessions = await listExtractedSessions(caseRow.id);
  const heading = <h2 className="text-lg font-semibold">Assessment report</h2>;
  if (sessions.length === 0) {
    return (
      <div className="space-y-3">
        {heading}
        <p className="text-slate-700">{CONFIRM_FIRST}</p>
      </div>
    );
  }

  const selected = sessions.find((s) => s.id === session) ?? sessions[sessions.length - 1];
  const [facts, report] = await Promise.all([listIsaaFacts(selected.id), getAssessmentReport(selected.id)]);
  const hasConfirmed = decidedFacts(facts).length > 0;
  const parentNote = report?.status === "final" ? await getParentSummary(selected.id) : null;
  const parentAudioUrl = parentNote?.audio_path ? await signedAudioUrl(parentNote.audio_path, AUDIO_PLAYER_TTL_SEC) : null;

  return (
    <div className="space-y-4">
      {heading}
      <SessionSelect
        sessions={sessions.map((s) => ({ id: s.id, session_number: s.session_number }))}
        selectedId={selected.id}
      />
      {hasConfirmed || report ? (
        <ReportEditor
          key={selected.id}
          recordingId={selected.id}
          initialReport={report ? { id: report.id, content_md: report.content_md, status: report.status } : null}
        />
      ) : (
        <p className="text-slate-700">{CONFIRM_FIRST}</p>
      )}
      {report?.status === "final" && (
        <ParentVoiceNote
          key={`${selected.id}-${parentNote?.updated_at ?? "none"}`}
          reportId={report.id}
          initialNote={noteView(parentNote, parentAudioUrl)}
        />
      )}
    </div>
  );
}
