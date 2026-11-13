import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCasePage } from "@/lib/authz";
import { getFormatter, getT } from "@/lib/i18n/server";
import { getCase } from "@/lib/queries/cases";
import { listSharedForCase } from "@/lib/sharing/shared";

export const dynamic = "force-dynamic";

// 022 FR-6: what guardians shared with this case's organisation from their child's other organisations.
export default async function SharedWithUsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user } = await requireCasePage(id);
  const caseRow = await getCase(id);
  if (!caseRow?.child_id) notFound();

  const [sources, t, ts, format] = await Promise.all([
    listSharedForCase(user.id, { id: caseRow.id, org_id: caseRow.org_id, child_id: caseRow.child_id }),
    getT("sharedWithUs"),
    getT("sharing.scopes"),
    getFormatter(),
  ]);

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">{t("title")}</h2>
        <p className="text-sm text-slate-700">{t("intro")}</p>
      </div>
      {sources.length === 0 ? (
        <p className="text-slate-700">{t("empty")}</p>
      ) : (
        sources.map((source) => (
          <section key={source.sourceOrgId} className="space-y-3 rounded border border-slate-200 bg-white p-4" aria-label={t("from", { org: source.sourceOrgName })}>
            <header>
              <h3 className="text-base font-semibold break-words">{t("from", { org: source.sourceOrgName })}</h3>
              <p className="text-xs text-slate-600">
                {source.expiresAt ? t("until", { date: format.date(source.expiresAt, "long") }) : t("untilStopped")}
              </p>
            </header>
            {source.scopes.map((s) => (
              <div key={s.scope} className="space-y-1" data-scope={s.scope}>
                <h4 className="text-sm font-semibold text-slate-800">{ts(s.scope)}</h4>
                {!s.available ? (
                  <p className="text-sm text-slate-600">{t("notAvailable")}</p>
                ) : s.items.length === 0 ? (
                  <p className="text-sm text-slate-600">{t("noItems")}</p>
                ) : (
                  <ul className="space-y-1">
                    {s.items.map((item) => (
                      <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                        <span className="break-words">
                          {item.title} <span className="text-slate-600">· {format.date(item.date, "short")}</span>
                        </span>
                        <Link
                          href={`/cases/${caseRow.id}/shared/${s.scope}/${item.id}`}
                          className="font-medium text-slate-900 underline"
                          aria-label={`${t("open")}: ${item.title}`}
                        >
                          {t("open")}
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </section>
        ))
      )}
    </div>
  );
}
