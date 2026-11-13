import { FamilyEmptyState } from "@/components/family/FamilyEmptyState";
import { EmergencyBanner } from "@/components/messaging/EmergencyBanner";
import { LiveThreadsRefresher } from "@/components/messaging/LiveThreadsRefresher";
import { NewThreadForm } from "@/components/messaging/NewThreadForm";
import { ThreadList } from "@/components/messaging/ThreadList";
import { requireGuardianPage } from "@/lib/authz";
import { listGuardianChildren } from "@/lib/children";
import { getFormatter, getT } from "@/lib/i18n/server";
import { listCasesForChildren, listThreads } from "@/lib/messaging/store";

export const dynamic = "force-dynamic";

// 027 FR-4: the guardian's conversations across children, grouped by child, each with `New message` addressed to
// one of the child's treating organisations (case).
export default async function FamilyMessagesPage() {
  const { user } = await requireGuardianPage();
  const [children, t, format] = await Promise.all([listGuardianChildren(user.id), getT("messaging"), getFormatter()]);
  if (children.length === 0) return <FamilyEmptyState title={t("title")} message={t("noChildren")} />;

  const childIds = children.map(({ child }) => child.id);
  const [threads, cases] = await Promise.all([listThreads(user.id), listCasesForChildren(childIds)]);

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold text-slate-900 sm:text-3xl">{t("title")}</h1>
        <p className="text-slate-600">{t("familyIntro")}</p>
      </header>
      <EmergencyBanner />
      <LiveThreadsRefresher endpoint="/api/threads" />
      {children.map(({ child }) => {
        const own = cases.filter((c) => c.child_id === child.id);
        const choices = own.map((c) => ({
          id: c.id,
          label: own.filter((o) => o.org_id === c.org_id).length > 1 ? t("caseOption", { org: c.org_name, date: format.date(c.created_at, "short") }) : c.org_name,
        }));
        const heading = t("childTitle", { name: child.display_name });
        return (
          <section key={child.id} aria-labelledby={`msg-${child.id}`} className="space-y-3" data-child={child.id}>
            <h2 id={`msg-${child.id}`} className="text-xl font-semibold break-words text-slate-900">
              {heading}
            </h2>
            {choices.length > 0 ? (
              <NewThreadForm cases={choices} hrefBase="/family/messages" tone="family" idPrefix={`c${child.id.slice(0, 8)}`} />
            ) : (
              <p className="text-slate-600">{t("noCareTeam", { name: child.display_name })}</p>
            )}
            <ThreadList threads={threads.filter((x) => x.child_id === child.id)} hrefBase="/family/messages" show="org" label={heading} />
          </section>
        );
      })}
    </div>
  );
}
