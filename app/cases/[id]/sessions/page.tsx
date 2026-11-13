import Link from "next/link";
import { notFound } from "next/navigation";
import { formatDate } from "@/lib/cases/format";
import { getCase, listSessions } from "@/lib/queries/cases";
import { requireCasePage } from "@/lib/authz";
import { getT } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

export default async function SessionsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireCasePage(id);
  const caseRow = await getCase(id);
  if (!caseRow) notFound();
  const sessions = await listSessions(id);
  const t = await getT("scribe");

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Sessions</h2>
        <Link href={`/cases/${id}/sessions/new`} className="rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white">
          New session
        </Link>
      </div>
      {sessions.length === 0 ? (
        <p className="text-slate-600">No sessions yet.</p>
      ) : (
        <ul className="divide-y divide-slate-200 rounded border border-slate-200">
          {sessions.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
              <span className="font-medium">Session {s.session_number}</span>
              <span className="text-slate-600">{t(`templates.${s.template ?? "child_dev_isaa"}`)}</span>
              <span className="text-slate-600">{s.status}</span>
              <span className="text-slate-600">{formatDate(s.created_at)}</span>
              <Link href={`/cases/${id}/sessions/${s.id}`} className="underline">
                Open
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
