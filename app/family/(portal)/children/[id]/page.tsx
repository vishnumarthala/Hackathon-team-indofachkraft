import Link from "next/link";
import { LeaveChildButton } from "@/components/family/children/LeaveChildButton";
import { PermissionCard, type PermissionView } from "@/components/family/children/PermissionCard";
import { requireChildGuardianPage, requireGuardianPage } from "@/lib/authz";
import { ageLabel } from "@/lib/children/age";
import { CONSENT_FEATURES, getConsentState } from "@/lib/consent";
import { currentDocuments } from "@/lib/consent/records";
import { getLocale, getT } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

// 020 FR-13: child overview (active link required, else 404) with the Permissions section.
export default async function ChildOverviewPage({ params }: { params: Promise<{ id: string }> }) {
  await requireGuardianPage();
  const { id } = await params;
  const { child, session } = await requireChildGuardianPage(id);
  const [t, tc, th, td, locale] = [
    await getT("family.children"),
    await getT("consent"),
    await getT("health"),
    await getT("documents"),
    await getLocale(),
  ];
  const ti = await getT("iep.family");
  const [state, docs] = await Promise.all([getConsentState(child.id), currentDocuments(locale)]);

  const views: PermissionView[] = CONSENT_FEATURES.map((feature) => {
    const doc = docs.find((d) => d.feature === feature) ?? null;
    const s = state[feature];
    return {
      feature,
      name: tc(`features.${feature}.name`),
      description: tc(`features.${feature}.description`),
      document: doc
        ? { id: doc.id, title: doc.title, version: doc.version, body: doc.body_md, processors: doc.processors }
        : null,
      granted: s.granted,
      method: s.method,
      paperSignedOn: s.paper_signed_on,
    };
  });

  return (
    <div className="space-y-6">
      <Link href="/family/children" className="inline-flex min-h-11 items-center text-sm font-semibold text-teal-800 underline">
        {t("backToList")}
      </Link>
      <header className="space-y-1">
        <h1 className="text-2xl font-bold break-words text-slate-900 sm:text-3xl">{child.display_name}</h1>
        <p className="text-slate-600">{ageLabel(t, child.date_of_birth)}</p>
      </header>
      <div className="flex flex-wrap gap-x-6">
        <Link
          href={`/family/children/${child.id}/team`}
          className="inline-flex min-h-11 items-center font-semibold text-teal-800 underline"
        >
          {t("team.link")}
        </Link>
        <Link
          href={`/family/children/${child.id}/documents`}
          className="inline-flex min-h-11 items-center font-semibold text-teal-800 underline"
        >
          {td("link")}
        </Link>
        <Link
          href={`/family/children/${child.id}/health`}
          className="inline-flex min-h-11 items-center font-semibold text-teal-800 underline"
        >
          {th("link")}
        </Link>
        <Link
          href={`/family/children/${child.id}/plan`}
          className="inline-flex min-h-11 items-center font-semibold text-teal-800 underline"
        >
          {ti("link")}
        </Link>
        <Link
          href={`/family/children/${child.id}/privacy`}
          className="inline-flex min-h-11 items-center font-semibold text-teal-800 underline"
        >
          {(await getT("privacy.family"))("link")}
        </Link>
      </div>
      <section aria-labelledby="permissions-heading" className="space-y-3">
        <h2 id="permissions-heading" className="text-xl font-semibold text-slate-900">
          {t("overview.permissions")}
        </h2>
        <p className="text-slate-700">{t("overview.permissionsIntro")}</p>
        <ul className="space-y-4">
          {views.map((view) => (
            <PermissionCard
              key={view.feature}
              childId={child.id}
              view={view}
              phoneVerified={Boolean(session.profile.phone_verified_at)}
            />
          ))}
        </ul>
      </section>
      <LeaveChildButton childId={child.id} name={child.display_name} />
    </div>
  );
}
