import Link from "next/link";
import { ReportPreview } from "@/components/report/ReportEditor";
import { requireChildGuardianPage, requireGuardianPage } from "@/lib/authz";
import { getFormatter, getT } from "@/lib/i18n/server";
import { listGuardianPrescriptions } from "@/lib/rx";

export const dynamic = "force-dynamic";

// 039 FR-5: signed prescriptions published to guardians (024 published versions) with `Download PDF`; cancelled ones
// stay listed as `Cancelled by prescriber` without a download. Drafts and AI drafts never appear here.
export default async function ChildPrescriptionsPage({ params }: { params: Promise<{ id: string }> }) {
  await requireGuardianPage();
  const { id } = await params;
  const { child } = await requireChildGuardianPage(id);
  const [items, t, format] = await Promise.all([listGuardianPrescriptions(child.id), getT("rx.family"), getFormatter()]);

  return (
    <div className="space-y-6">
      <Link href={`/family/children/${child.id}`} className="inline-flex min-h-11 items-center text-sm font-semibold text-teal-800 underline">
        {t("back", { name: child.display_name })}
      </Link>
      <header className="space-y-1">
        <h1 className="text-2xl font-bold break-words text-slate-900 sm:text-3xl">{t("title", { name: child.display_name })}</h1>
        <p className="text-slate-700">{t("intro")}</p>
      </header>
      {items.length === 0 ? (
        <p role="status" className="rounded-2xl border border-slate-200 bg-white p-4 text-slate-800">
          {t("empty")}
        </p>
      ) : (
        items.map((rx) => (
          <section key={rx.id} aria-labelledby={`rx-${rx.id}`} className="space-y-2" data-prescription={rx.id} data-status={rx.status}>
            <h2 id={`rx-${rx.id}`} className="text-xl font-semibold break-words text-slate-900">
              {t("from", { org: rx.org_name })}
            </h2>
            <p className="text-sm text-slate-600">{t("signedBy", { name: rx.prescriber_name, date: format.date(rx.signed_at, "long") })}</p>
            {rx.status === "void" ? (
              <div className="space-y-1 rounded-2xl border border-red-300 bg-red-50 p-4 text-red-900">
                <p className="font-semibold">{t("cancelled")}</p>
                <p className="text-sm">{t("cancelledNote")}</p>
              </div>
            ) : (
              <>
                <ReportPreview markdown={rx.content_md} />
                <a
                  href={`/api/family/prescriptions/${rx.id}/pdf`}
                  download
                  className="inline-flex min-h-11 items-center rounded-xl bg-teal-800 px-4 py-2 font-semibold text-white"
                >
                  {t("download")}
                </a>
              </>
            )}
          </section>
        ))
      )}
    </div>
  );
}
