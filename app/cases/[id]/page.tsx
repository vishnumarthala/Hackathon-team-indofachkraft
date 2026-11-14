import { notFound } from "next/navigation";
import { FacpForm } from "@/components/case/FacpForm";
import { ConsentPanel } from "@/components/consent/ConsentPanel";
import { TimetableCard } from "@/components/series/TimetableCard";
import { NEXT_STEPS, formatDate, type CaseStatus } from "@/lib/cases/format";
import { getCase } from "@/lib/queries/cases";
import { requireCasePage } from "@/lib/authz";

export const dynamic = "force-dynamic";

export default async function CaseOverviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await requireCasePage(id);
  const caseRow = await getCase(id);
  if (!caseRow) notFound();

  const details: [string, string][] = [
    ["Parent", caseRow.parent_alias],
    ["Parent email", caseRow.parent_email ?? "-"],
    ["Parent phone", caseRow.parent_phone ?? "-"],
    ["Therapist", caseRow.therapist_name],
    ["Created", formatDate(caseRow.created_at)],
  ];

  return (
    <div className="space-y-6">
      <div className="rounded border border-sky-200 bg-sky-50 p-4">
        <h2 className="text-sm font-semibold text-sky-900">Next step</h2>
        <p className="mt-1 text-sky-900">{NEXT_STEPS[caseRow.status as CaseStatus]}</p>
      </div>

      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">
        {details.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="font-medium text-slate-700">{label}</dt>
            <dd className="break-words text-slate-900">{value}</dd>
          </div>
        ))}
      </dl>

      {/* 052: the dashboard's `Invite parent` links here (`#parent-code`). */}
      {caseRow.child_id ? (
        <div id="parent-code" className="scroll-mt-4">
          <ConsentPanel caseRow={{ ...caseRow, child_id: caseRow.child_id }} />
        </div>
      ) : null}

      {/* 043 FR-6: weekly series of the child (staff who may schedule get the forms). */}
      <TimetableCard caseId={caseRow.id} userId={actor.user.id} />

      <FacpForm caseId={caseRow.id} initialScore={caseRow.facp_score ?? null} />
    </div>
  );
}
