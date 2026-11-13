import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { CaseTabs } from "@/components/case/CaseTabs";
import { StatusBadge } from "@/components/case/StatusBadge";
import { SevereAllergyBanner } from "@/components/health/SevereAllergyBanner";
import { languageName } from "@/lib/cases/format";
import { getCase } from "@/lib/queries/cases";
import { requireCasePage } from "@/lib/authz";

export const dynamic = "force-dynamic";

export default async function CaseLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  await requireCasePage(id);
  const caseRow = await getCase(id);
  if (!caseRow) notFound();

  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <header className="mb-4 print:hidden">
        <SevereAllergyBanner childId={caseRow.child_id ?? null} />
        <h1 className="text-2xl font-semibold break-words">{caseRow.child_alias}</h1>
        <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-slate-700">
          {caseRow.child_age_months != null && <span>{caseRow.child_age_months} months</span>}
          <span>{languageName(caseRow.language)}</span>
          <StatusBadge status={caseRow.status} />
        </p>
      </header>
      <div className="print:hidden">
        <CaseTabs caseId={caseRow.id} />
      </div>
      <section className="pt-5">{children}</section>
    </div>
  );
}
