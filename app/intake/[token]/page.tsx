import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { IntakeCall } from "@/components/intake/IntakeCall";
import { hasConsent } from "@/lib/consent";
import { getT } from "@/lib/i18n/server";
import { intakeLinkState } from "@/lib/intake/link";
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
  const t = await getT("intake");

  // 020 FR-10: expired or revoked links, and links whose child has no ai_intake_call consent, show the
  // expired message (fail closed: a failed consent check counts as no consent).
  const consented =
    Boolean(caseRow.child_id) && (await hasConsent(caseRow.child_id as string, "ai_intake_call").catch(() => false));
  if (intakeLinkState(caseRow) !== "active" || !consented) {
    return (
      <div className="mx-auto w-full max-w-md px-4 py-8">
        <p className="text-lg font-medium text-slate-900" data-testid="intake-expired">
          {t("expired")}
        </p>
      </div>
    );
  }

  const completed = await hasIntakeRecording(caseRow.id);

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
