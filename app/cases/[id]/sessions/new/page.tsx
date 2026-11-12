import { notFound } from "next/navigation";
import { UploadPanel } from "@/components/session/UploadPanel";
import { getCase } from "@/lib/queries/cases";
import { requireCasePage } from "@/lib/authz";

export const dynamic = "force-dynamic";

export default async function NewSessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireCasePage(id);
  const caseRow = await getCase(id);
  if (!caseRow) notFound();

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">New session</h2>
      <p className="text-sm text-slate-700">
        AI documents, the clinician decides. Upload the recording, then review every suggested rating.
      </p>
      <UploadPanel caseId={id} />
    </div>
  );
}
