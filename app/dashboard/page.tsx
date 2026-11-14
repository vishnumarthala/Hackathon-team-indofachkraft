import Link from "next/link";
import { CaseList } from "@/components/dashboard/CaseList";
import { StatCards, TodayPanel } from "@/components/dashboard/TodayPanel";
import { getActiveOrgIds, requireProviderPage } from "@/lib/authz";
import { caseHref, defaultCaseTab, loadCaseTabFacts } from "@/lib/cases/default-tab";
import { parseCaseFilter } from "@/lib/dashboard/cases-filter";
import { greetingPart, listCasesWithoutParent, loadDashboardToday, providerDisplayName } from "@/lib/dashboard/today";
import { getFormatter, getT, getTimeZone } from "@/lib/i18n/server";
import { listCases } from "@/lib/queries/cases";
import { Button, buttonClasses } from "@/components/ui/Button";

export const dynamic = "force-dynamic";

const secondary = buttonClasses({ variant: "secondary" });

// 052 FR-4 (Figma /dashboard — Cases 18:11): greeting with organisation and date, Invite parent / New case, the four
// stat cards, the Today panel (today's sessions + To do), then the case list. Translated (en/hi/te). Today first,
// cases second (D-3).
export default async function DashboardPage({ searchParams }: { searchParams: Promise<{ filter?: string; q?: string }> }) {
  const { user } = await requireProviderPage();
  const orgIds = await getActiveOrgIds(user.id);
  const timeZone = await getTimeZone();
  const t = await getT("dashboard");
  const format = await getFormatter();
  const { filter: rawFilter, q: rawQ } = await searchParams;
  const filter = parseCaseFilter(rawFilter);
  const q = typeof rawQ === "string" ? rawQ.slice(0, 100) : "";

  const [cases, today, invite, displayName] = await Promise.all([
    orgIds.length > 0 ? listCases(user.id) : Promise.resolve([]),
    loadDashboardToday(user.id, { timeZone }),
    orgIds.length > 0 ? listCasesWithoutParent(user.id) : Promise.resolve([]),
    providerDisplayName(user.id),
  ]);
  const tabFacts = await loadCaseTabFacts([...cases.map((c) => c.id), ...today.sessions.flatMap((s) => (s.case_id ? [s.case_id] : []))]);
  const caseLinks: Record<string, string> = {};
  for (const [id, facts] of tabFacts) caseLinks[id] = caseHref(id, defaultCaseTab(facts));

  const name = displayName ?? user.email?.split("@")[0] ?? t("there");
  const orgNames = today.memberships.map((m) => m.org.name).join(", ");
  const dateLabel = format.date(new Date(), "long");

  return (
    <div className="mx-auto max-w-5xl space-y-8 px-4 py-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold break-words text-slate-900">{t(`greeting.${greetingPart(timeZone)}`, { name })}</h1>
          <p className="mt-1 text-sm text-slate-600">{orgNames ? t("subtitle", { org: orgNames, date: dateLabel }) : dateLabel}</p>
        </div>
        {orgIds.length > 0 ? (
          <div className="flex flex-wrap items-start gap-2">
            <details className="group relative">
              <summary className={`${secondary} cursor-pointer list-none`} data-testid="invite-parent">
                {t("invite.button")}
              </summary>
              <div className="absolute right-0 z-20 mt-2 w-80 max-w-[90vw] space-y-2 rounded-xl border border-slate-200 bg-white p-4 text-sm shadow-lg">
                <p className="font-semibold text-slate-900">{t("invite.title")}</p>
                {invite.length ? (
                  <>
                    <p className="text-slate-600">{t("invite.intro")}</p>
                    <ul className="max-h-64 overflow-y-auto">
                      {invite.map((c) => (
                        <li key={c.id}>
                          <Link href={`/cases/${c.id}#parent-code`} className="flex min-h-11 items-center rounded px-2 font-medium text-teal-800 underline hover:bg-slate-50">
                            {c.child_alias}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <p className="text-slate-600">{t("invite.none")}</p>
                )}
                <Link href="/dashboard/import" className="inline-flex min-h-11 items-center font-semibold text-teal-800 underline">
                  {t("invite.import")}
                </Link>
              </div>
            </details>
            <Button href="/dashboard/import" variant="secondary">
              {t("import")}
            </Button>
            <Button href="/cases/new">{t("newCase")}</Button>
          </div>
        ) : null}
      </header>

      {orgIds.length === 0 ? (
        <div className="space-y-3 rounded-xl border border-dashed border-slate-300 bg-white p-6 text-slate-700">
          <p>{t("noOrg")}</p>
          <Button href="/dashboard/team">{t("noOrgAction")}</Button>
        </div>
      ) : (
        <>
          <StatCards stats={today.stats} />
          <TodayPanel today={today} userId={user.id} caseLinks={caseLinks} />
          <CaseList cases={cases} filter={filter} q={q} caseLinks={caseLinks} />
        </>
      )}
    </div>
  );
}
