import Link from "next/link";
import { SharingPanel, type SharingPairView } from "@/components/family/children/SharingPanel";
import { requireChildGuardianPage, requireGuardianPage } from "@/lib/authz";
import { listChildCareTeam } from "@/lib/cases/team";
import { getT } from "@/lib/i18n/server";
import { listActiveChildGrants } from "@/lib/sharing/grants";

export const dynamic = "force-dynamic";

// 022 FR-4: the child's care team grouped by organisation, and sharing between those organisations.
export default async function ChildTeamPage({ params }: { params: Promise<{ id: string }> }) {
  await requireGuardianPage();
  const { id } = await params;
  const { child } = await requireChildGuardianPage(id);
  const [orgs, grants, t, tp] = await Promise.all([
    listChildCareTeam(child.id),
    listActiveChildGrants(child.id),
    getT("family.children.team"),
    getT("providers.types"),
  ]);

  const pairs: SharingPairView[] = orgs.flatMap((source) =>
    orgs
      .filter((grantee) => grantee.org_id !== source.org_id)
      .map((grantee) => {
        const grant = grants.find((g) => g.source_org_id === source.org_id && g.grantee_org_id === grantee.org_id);
        return {
          sourceOrgId: source.org_id,
          sourceName: source.org_name,
          granteeOrgId: grantee.org_id,
          granteeName: grantee.org_name,
          grant: grant ? { id: grant.id, scopes: grant.scopes, expiresAt: grant.expires_at } : null,
        };
      }),
  );

  return (
    <div className="space-y-6">
      <Link href={`/family/children/${child.id}`} className="inline-flex min-h-11 items-center text-sm font-semibold text-teal-800 underline">
        {t("back", { name: child.display_name })}
      </Link>
      <header className="space-y-1">
        <h1 className="text-2xl font-bold break-words text-slate-900 sm:text-3xl">{t("title")}</h1>
        <p className="text-slate-600">{t("intro", { name: child.display_name })}</p>
      </header>

      {orgs.length === 0 ? (
        <p className="rounded-2xl bg-slate-50 p-4 text-slate-700">{t("noOrgs", { name: child.display_name })}</p>
      ) : (
        <ul className="space-y-4">
          {orgs.map((org) => (
            <li key={org.org_id} className="space-y-2 rounded-2xl border border-slate-200 bg-white p-4" data-org={org.org_id}>
              <h2 className="text-lg font-semibold break-words text-slate-900">{org.org_name}</h2>
              {org.providers.length === 0 ? (
                <p className="text-sm text-slate-600">{t("noProviders")}</p>
              ) : (
                <ul className="space-y-1">
                  {org.providers.map((p) => {
                    const discipline = p.discipline_label ?? (p.provider_type ? tp(p.provider_type) : null);
                    return (
                      <li key={p.user_id} className="text-slate-800">
                        <span className="font-medium break-words">{p.display_name ?? t("unnamed")}</span>
                        {discipline ? <span className="text-slate-600"> - {discipline}</span> : null}
                        {p.care_role === "lead" ? <span className="text-slate-600"> - {t("lead")}</span> : null}
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}

      <section aria-labelledby="sharing-heading" className="space-y-3">
        <h2 id="sharing-heading" className="text-xl font-semibold text-slate-900">
          {t("sharingTitle")}
        </h2>
        <p className="font-medium text-slate-900">{t("sharingIntro")}</p>
        <p className="text-slate-700">{t("sharingExplain")}</p>
        {pairs.length === 0 ? (
          <p className="rounded-2xl bg-slate-50 p-4 text-slate-700">{t("needTwo", { name: child.display_name })}</p>
        ) : (
          <SharingPanel childId={child.id} pairs={pairs} />
        )}
      </section>
    </div>
  );
}
