import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { IntakeCall } from "@/components/intake/IntakeCall";
import { getCaseByToken, hasIntakeRecording } from "@/lib/queries/intake";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "CareThread intake call",
  robots: { index: false, follow: false },
};

export default async function IntakePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const caseRow = await getCaseByToken(token);
  if (!caseRow) notFound();

  const completed = await hasIntakeRecording(caseRow.id);

  return (
    <div className="mx-auto w-full max-w-md px-4 py-8">
      {completed ? (
        <p className="text-lg font-medium text-slate-900">Thank you, your intake call is complete.</p>
      ) : (
        <IntakeCall token={token} childAlias={caseRow.child_alias} defaultLanguage={caseRow.language} />
      )}
    </div>
  );
}
