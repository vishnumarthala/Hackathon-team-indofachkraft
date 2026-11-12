import type { Metadata } from "next";
import Link from "next/link";
import { ReviewActions } from "@/components/providers/AdminActions";
import { requirePlatformAdminPage } from "@/lib/authz";
import { getFormatter, getT } from "@/lib/i18n/server";
import { registerSearchUrl } from "@/lib/providers/constants";
import { listPendingSubmissions } from "@/lib/providers/verification";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT("providers.adminVerifications");
  return { title: t("metaTitle") };
}

// FR-4 platform-admin verification queue. Other roles get 404.
export default async function VerificationQueuePage() {
  await requirePlatformAdminPage();
  const t = await getT("providers");
  const nav = await getT();
  const format = await getFormatter();
  const submissions = await listPendingSubmissions();

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-6">
      <nav className="flex flex-wrap gap-4 text-sm">
        <Link href="/dashboard" className="font-medium text-slate-700 underline">
          {nav("nav.dashboard")}
        </Link>
        <Link href="/admin/providers" className="font-medium text-slate-700 underline">
          {t("nav.providers")}
        </Link>
      </nav>
      <h1 className="text-2xl font-semibold text-slate-900">{t("adminVerifications.title")}</h1>
      {submissions.length === 0 ? (
        <p className="text-slate-700">{t("adminVerifications.empty")}</p>
      ) : (
        <ul className="space-y-4">
          {submissions.map((s) => {
            const register = registerSearchUrl(s.council);
            const council = s.council as "NMC" | "STATE_MEDICAL_COUNCIL" | "RCI" | "OTHER";
            return (
              <li key={s.id} className="grid gap-4 rounded border border-slate-200 bg-white p-4 md:grid-cols-2">
                <div className="space-y-1 text-sm text-slate-800">
                  <p className="text-base font-semibold text-slate-900">
                    {s.profile.display_name}
                    {s.profile.is_synthetic ? (
                      <span className="ml-2 rounded bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-900">{t("demoBadge")}</span>
                    ) : null}
                  </p>
                  <p>{t(`types.${s.profile.provider_type as "pediatrician"}`)}</p>
                  <p>
                    {t(`councils.${council}`)}
                    {s.state ? ` (${s.state})` : ""}: <span className="font-mono">{s.registration_number}</span>
                  </p>
                  <p className="text-slate-600">{t("adminVerifications.submittedOn", { date: format.dateTime(s.created_at) })}</p>
                  <p>
                    {s.certificate_path ? (
                      <a href={`/api/admin/verifications/${s.id}/certificate`} className="font-medium underline" target="_blank" rel="noopener noreferrer">
                        {t("adminVerifications.certificate")}
                      </a>
                    ) : (
                      t("adminVerifications.noCertificate")
                    )}
                  </p>
                  <p>
                    {register ? (
                      <a href={register} className="font-medium underline" target="_blank" rel="noopener noreferrer">
                        {t("adminVerifications.register")}
                      </a>
                    ) : (
                      t("adminVerifications.noRegister")
                    )}
                  </p>
                </div>
                <ReviewActions submissionId={s.id} council={s.council} />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
