import Link from "next/link";
import { STATUS_KEYS, STATUS_STYLES } from "@/components/assessments/view";
import { listGuardianAssessments } from "@/lib/assessments";
import { requireGuardianPage } from "@/lib/authz";
import { getFormatter, getT } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

// 024 FR-9: questionnaires assigned to this guardian (child, title, due date, status).
export default async function FamilyAssessmentsPage() {
  const { user } = await requireGuardianPage();
  const [items, t, ts, format] = await Promise.all([
    listGuardianAssessments(user.id),
    getT("family.assessments"),
    getT("assessments.status"),
    getFormatter(),
  ]);

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-bold text-slate-900 sm:text-3xl">{t("title")}</h1>
        <p className="text-slate-700">{t("intro")}</p>
      </div>
      {items.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-slate-300 bg-white p-6 text-center text-slate-600">{t("empty")}</p>
      ) : (
        <ul className="space-y-3" aria-label={t("title")}>
          {items.map((a) => {
            const open = a.status === "assigned" || a.status === "in_progress";
            return (
              <li key={a.id} data-assessment={a.id}>
                <Link
                  href={`/family/assessments/${a.id}`}
                  className="block min-h-11 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm hover:border-teal-600 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-600/30"
                >
                  <span className="flex flex-wrap items-start justify-between gap-2">
                    <span className="min-w-0">
                      <span className="block font-semibold text-slate-900 break-words">{a.title}</span>
                      <span className="block text-sm text-slate-700">{t("forChild", { child: a.child_name })}</span>
                      <span className="block text-sm text-slate-700">
                        {a.due_on ? t("due", { date: format.date(`${a.due_on}T12:00:00+05:30`, "long") }) : t("noDue")}
                      </span>
                    </span>
                    <span className={`rounded-full px-3 py-1 text-xs font-semibold ${STATUS_STYLES[a.status]}`}>
                      {ts(STATUS_KEYS[a.status])}
                    </span>
                  </span>
                  <span className="mt-2 block text-sm font-semibold text-teal-800">
                    {open ? (a.status === "assigned" ? t("start") : t("continue")) : a.has_summary ? t("viewResult") : t("view")}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
