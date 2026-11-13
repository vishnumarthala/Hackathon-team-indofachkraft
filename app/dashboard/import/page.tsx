import Link from "next/link";
import { requireProviderPage } from "@/lib/authz";
import { getFormatter, getT } from "@/lib/i18n/server";
import { listImports } from "@/lib/import/store";
import { canManage, listMemberships } from "@/lib/orgs";
import { ImportWizard } from "./ImportClient";

export const dynamic = "force-dynamic";

// 047 FR-1: owner/admin uploads a CSV of the children the centre already sees, previews it and imports it.
export default async function ImportPage() {
  const { user } = await requireProviderPage();
  const t = await getT("childImport");
  const format = await getFormatter();
  const orgs = (await listMemberships(user.id)).filter((m) => canManage(m.org_role)).map((m) => m.org);
  const history = await Promise.all(orgs.map(async (org) => ({ org, imports: await listImports(org.id, 10) })));

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-slate-700">{t("intro")}</p>
      </header>

      {orgs.length === 0 ? (
        <p className="text-slate-700" data-testid="only-managers">
          {t("onlyManagers")}
        </p>
      ) : (
        <>
          <ImportWizard orgs={orgs.map((o) => ({ id: o.id, name: o.name }))} />
          <section className="space-y-3 rounded border border-slate-200 bg-white p-4">
            <h2 className="text-lg font-semibold">{t("historyTitle")}</h2>
            {history.every((h) => h.imports.length === 0) ? <p className="text-sm text-slate-700">{t("historyNone")}</p> : null}
            {history
              .filter((h) => h.imports.length > 0)
              .map(({ org, imports }) => (
                <div key={org.id} className="space-y-1">
                  {orgs.length > 1 ? <h3 className="font-medium">{org.name}</h3> : null}
                  <ul className="space-y-1 text-sm">
                    {imports.map((imp) => (
                      <li key={imp.id}>
                        <Link href={`/dashboard/import/${imp.id}`} className="inline-flex min-h-11 items-center underline">
                          {t("historyRow", {
                            date: format.dateTime(imp.created_at),
                            imported: imp.imported_count,
                            skipped: imp.skipped_count,
                            failed: imp.failed_count,
                          })}
                        </Link>
                        {imp.undone_at ? <span className="ml-2 text-slate-600">({t("undoneLabel")})</span> : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
          </section>
        </>
      )}
    </div>
  );
}
