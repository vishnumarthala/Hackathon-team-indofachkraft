import Link from "next/link";
import { ReportPreview } from "@/components/report/ReportEditor";
import { requireChildGuardianPage, requireGuardianPage } from "@/lib/authz";
import { getFormatter, getT } from "@/lib/i18n/server";
import { listGuardianSessionNotes } from "@/lib/scribe/queries";

export const dynamic = "force-dynamic";

// 038 NFR-1: session notes the child's clinicians finalized AND chose to share (latest published version visible to
// the guardian). Drafts, goal suggestions and prescription drafts never appear here.
export default async function ChildSessionNotesPage({ params }: { params: Promise<{ id: string }> }) {
  await requireGuardianPage();
  const { id } = await params;
  const { child } = await requireChildGuardianPage(id);
  const [notes, t, format] = await Promise.all([listGuardianSessionNotes(child.id), getT("scribe.family"), getFormatter()]);

  return (
    <div className="space-y-6">
      <Link href={`/family/children/${child.id}`} className="inline-flex min-h-11 items-center text-sm font-semibold text-teal-800 underline">
        {t("back", { name: child.display_name })}
      </Link>
      <header className="space-y-1">
        <h1 className="text-2xl font-bold break-words text-slate-900 sm:text-3xl">{t("title", { name: child.display_name })}</h1>
        <p className="text-slate-700">{t("intro")}</p>
      </header>
      {notes.length === 0 ? (
        <p role="status" className="rounded-2xl border border-slate-200 bg-white p-4 text-slate-800">
          {t("empty")}
        </p>
      ) : (
        notes.map((note) => (
          <section key={note.report_id} aria-labelledby={`note-${note.report_id}`} className="space-y-2" data-note={note.report_id}>
            <h2 id={`note-${note.report_id}`} className="text-xl font-semibold break-words text-slate-900">
              {t("from", { org: note.org_name })}
            </h2>
            <p className="text-sm text-slate-600">{t("sharedOn", { date: format.date(note.published_at, "long") })}</p>
            <ReportPreview markdown={note.content_md} />
          </section>
        ))
      )}
    </div>
  );
}
