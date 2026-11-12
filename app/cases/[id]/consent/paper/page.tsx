import Link from "next/link";
import { notFound } from "next/navigation";
import { ConsentPanel } from "@/components/consent/ConsentPanel";
import { PaperConsentForm, PaperWithdrawForm, type PaperFormDocs } from "@/components/consent/PaperConsentForm";
import { requireCasePage } from "@/lib/authz";
import { CONSENT_FEATURES, type ConsentFeature } from "@/lib/consent";
import { currentDocuments } from "@/lib/consent/records";
import { getT } from "@/lib/i18n/server";
import { getCase } from "@/lib/queries/cases";

export const dynamic = "force-dynamic";

// 020 FR-18c/FR-18e: record paper consent (works for legacy cases too) or a paper withdrawal.
export default async function PaperConsentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireCasePage(id);
  const caseRow = await getCase(id);
  if (!caseRow?.child_id) notFound();
  const t = await getT("paperConsent");
  const tc = await getT("consent");
  const [en, hi, te] = await Promise.all([currentDocuments("en"), currentDocuments("hi"), currentDocuments("te")]);
  const slim = (docs: typeof en) => docs.map((d) => ({ feature: d.feature, id: d.id, version: d.version }));
  const docs: PaperFormDocs = { en: slim(en), hi: slim(hi), te: slim(te) };
  const featureNames = Object.fromEntries(CONSENT_FEATURES.map((f) => [f, tc(`features.${f}.name`)])) as Record<
    ConsentFeature,
    string
  >;

  return (
    <div className="space-y-6">
      <Link href={`/cases/${id}`} className="inline-flex min-h-11 items-center text-sm font-medium underline">
        {t("back")}
      </Link>
      <section className="space-y-3 rounded border border-slate-200 p-4">
        <h2 className="text-lg font-semibold">{t("title")}</h2>
        <p className="text-sm text-slate-700">{t("intro")}</p>
        <PaperConsentForm caseId={id} docs={docs} defaultLocale={caseRow.language} featureNames={featureNames} />
      </section>
      <section className="space-y-3 rounded border border-slate-200 p-4">
        <h2 className="text-lg font-semibold">{t("withdrawTitle")}</h2>
        <p className="text-sm text-slate-700">{t("withdrawIntro")}</p>
        <PaperWithdrawForm caseId={id} featureNames={featureNames} />
      </section>
      <ConsentPanel caseRow={{ ...caseRow, child_id: caseRow.child_id }} />
    </div>
  );
}
