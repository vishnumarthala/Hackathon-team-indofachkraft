import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { IntakeCall } from "@/components/intake/IntakeCall";
import { getT } from "@/lib/i18n/server";
import { getCaseByToken, hasIntakeRecording } from "@/lib/queries/intake";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT("intake.meta");
  return { title: t("title"), robots: { index: false, follow: false } };
}

export default async function IntakePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const caseRow = await getCaseByToken(token);
  if (!caseRow) notFound();

  const completed = await hasIntakeRecording(caseRow.id);
  const t = await getT("intake");

  return (
    <div className="mx-auto w-full max-w-md px-4 py-8">
      {completed ? (
        <p className="text-lg font-medium text-slate-900">{t("complete")}</p>
      ) : (
        <IntakeCall token={token} childAlias={caseRow.child_alias} defaultLanguage={caseRow.language} />
      )}
    </div>
  );
}
