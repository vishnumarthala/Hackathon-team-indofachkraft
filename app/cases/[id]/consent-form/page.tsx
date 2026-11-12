import Link from "next/link";
import { notFound } from "next/navigation";
import { PrintButton } from "@/components/consent/PrintButton";
import { requireCasePage } from "@/lib/authz";
import { currentDocuments } from "@/lib/consent/records";
import { supabaseAdmin } from "@/lib/db";
import { isLocale, LOCALE_LABELS, LOCALES, type Locale } from "@/lib/i18n/config";
import { getMessages } from "@/lib/i18n/messages";
import { createTranslator } from "@/lib/i18n/translate";
import { getCase } from "@/lib/queries/cases";

export const dynamic = "force-dynamic";

// 020 FR-18b: printable consent form in the chosen language. Printing it is not consent.
export default async function ConsentFormPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ locale?: string }>;
}) {
  const { id } = await params;
  await requireCasePage(id);
  const caseRow = await getCase(id);
  if (!caseRow) notFound();
  const requested = (await searchParams).locale;
  const locale: Locale = isLocale(requested) ? requested : caseRow.language;
  const messages = getMessages(locale);
  const t = createTranslator(locale, messages, "consentForm");
  const tc = createTranslator(locale, messages, "consent");
  const tr = createTranslator(locale, messages, "family.children.form");
  const docs = await currentDocuments(locale);
  const { data: org } = await supabaseAdmin().from("organizations").select("name").eq("id", caseRow.org_id).maybeSingle();

  return (
    <article lang={locale} className="mx-auto max-w-3xl space-y-6 bg-white text-slate-900" data-testid="consent-form">
      <div className="flex flex-wrap items-center gap-3 print:hidden">
        <span className="text-sm font-medium text-slate-700">{t("language")}:</span>
        {LOCALES.map((l) => (
          <Link
            key={l}
            href={`/cases/${id}/consent-form?locale=${l}`}
            aria-current={l === locale ? "page" : undefined}
            className={`min-h-11 rounded px-3 py-2 text-sm ${l === locale ? "bg-slate-900 text-white" : "border border-slate-300"}`}
          >
            {LOCALE_LABELS[l]}
          </Link>
        ))}
        <PrintButton label={t("print")} />
      </div>
      <header className="space-y-1 border-b border-slate-300 pb-4">
        <h1 className="text-2xl font-semibold">DoctorNearMe: {t("title")}</h1>
        <p>
          <strong>{t("child")}:</strong> {caseRow.child_alias}
        </p>
        <p>
          <strong>{t("centre")}:</strong> {(org as { name: string } | null)?.name ?? ""}
        </p>
        <p className="text-sm">{t("intro")}</p>
      </header>
      <ol className="space-y-6">
        {docs.map((doc) => (
          <li key={doc.id} className="break-inside-avoid space-y-2 border-b border-slate-200 pb-4" data-feature={doc.feature}>
            <h2 className="text-lg font-semibold">{doc.title}</h2>
            <p className="text-sm whitespace-pre-line">{doc.body_md.replace(/\*\*/g, "")}</p>
            <p className="text-sm font-semibold">{tc("processors")}</p>
            <ul className="list-disc pl-5 text-sm">
              {doc.processors.map((p) => (
                <li key={`${p.name}-${p.purpose}`}>{tc("processor", p)}</li>
              ))}
            </ul>
            <p className="flex items-center gap-3 pt-1 text-base">
              <span aria-hidden="true" className="inline-block h-6 w-6 border-2 border-slate-900" />
              {t("tick")}
            </p>
            <p className="text-xs text-slate-600">
              {t("formVersion")}: {doc.feature} v{doc.version} {doc.locale} · {doc.id}
            </p>
          </li>
        ))}
      </ol>
      <section className="grid gap-6 pt-2 sm:grid-cols-2">
        {[t("signature"), t("name"), t("relationship"), t("date")].map((label) => (
          <div key={label} className="space-y-6">
            <p className="text-sm font-semibold">{label}</p>
            <div className="border-b border-slate-900" />
          </div>
        ))}
      </section>
      <p className="text-xs text-slate-600">
        {tr("relationships.mother")} / {tr("relationships.father")} / {tr("relationships.legal_guardian")} /{" "}
        {tr("relationships.other_family")}
      </p>
      <p className="rounded border border-slate-300 p-3 text-sm">{t("notConsent")}</p>
    </article>
  );
}
