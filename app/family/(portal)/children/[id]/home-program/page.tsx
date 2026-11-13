import Link from "next/link";
import { DoneToday, PendingLogsSync } from "@/components/home-program/DoneToday";
import { Instructions } from "@/components/home-program/Instructions";
import { requireChildGuardianPage, requireGuardianPage } from "@/lib/authz";
import { getGuardianHomePrograms, listOwnLogs, type GuardianActivity } from "@/lib/home-program";
import { getFormatter, getT, getTimeZone } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

/** Activities grouped by their linked goal (published wording), in program order; activities without a goal last. */
function byGoal(activities: GuardianActivity[]): { goal: string | null; activities: GuardianActivity[] }[] {
  const groups: { key: string; goal: string | null; activities: GuardianActivity[] }[] = [];
  for (const a of activities) {
    const key = a.goal?.id ?? "";
    let group = groups.find((g) => g.key === key);
    if (!group) {
      group = { key, goal: a.goal?.statement ?? null, activities: [] };
      groups.push(group);
    }
    group.activities.push(a);
  }
  return groups.sort((x, y) => Number(x.goal === null) - Number(y.goal === null));
}

// 026 FR-5: `This week` for one child: each published home program (snapshot only, NFR-2) with `<done>/<frequency> this
// week` per activity (Monday-start weeks in the guardian's time zone), instructions as written (NFR-3), the attached
// guide (download through the 023 access check) and `Done today`.
export default async function ChildHomeProgramPage({ params }: { params: Promise<{ id: string }> }) {
  await requireGuardianPage();
  const { id } = await params;
  const { child, session } = await requireChildGuardianPage(id);
  const timeZone = await getTimeZone();
  const [programs, t, tf, format] = await Promise.all([
    getGuardianHomePrograms(child.id, { timeZone }),
    getT("homeProgram.family"),
    getT("homeProgram.fields"),
    getFormatter(),
  ]);
  const first = programs[0];
  const ownLogs = first
    ? await listOwnLogs(session.user.id, programs.flatMap((p) => p.activities.map((a) => a.id)), first.week_start, first.week_end)
    : [];
  const day = (d: string) => format.date(`${d}T12:00:00Z`, "short");

  return (
    <div className="space-y-6">
      <PendingLogsSync />
      <Link href={`/family/children/${child.id}`} className="inline-flex min-h-11 items-center text-sm font-semibold text-teal-800 underline">
        {t("back", { name: child.display_name })}
      </Link>
      <header className="space-y-1">
        <h1 className="text-2xl font-bold break-words text-slate-900 sm:text-3xl">{t("title", { name: child.display_name })}</h1>
        <p className="text-slate-700">{t("intro")}</p>
      </header>

      {programs.length === 0 ? (
        <p role="status" className="rounded-2xl border border-slate-200 bg-white p-4 text-slate-800">
          {t("empty")}
        </p>
      ) : (
        programs.map((program) => (
          <section key={program.program_id} aria-labelledby={`program-${program.program_id}`} className="space-y-4" data-program={program.program_id}>
            <div className="space-y-1">
              <h2 id={`program-${program.program_id}`} className="text-xl font-semibold break-words text-slate-900">
                {program.title}
              </h2>
              <p className="text-sm text-slate-600">{t("from", { org: program.org_name })}</p>
              <p className="text-sm font-semibold text-slate-900">
                {t("thisWeek")}: {t("weekRange", { from: day(program.week_start), to: day(program.week_end) })}
              </p>
            </div>
            {byGoal(program.activities).map((group, i, groups) => (
              <div key={group.goal ?? "none"} className="space-y-3">
                {group.goal ? (
                  <h3 className="text-base font-semibold break-words text-slate-900">{t("goal", { goal: group.goal })}</h3>
                ) : groups.length > 1 ? (
                  <h3 className="text-base font-semibold text-slate-900">{t("otherActivities")}</h3>
                ) : null}
                <ul className="space-y-4">
                  {group.activities.map((a) => (
                    <li key={a.id} className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4" data-activity={a.id}>
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <h4 className="text-lg font-semibold break-words text-slate-900">{a.title}</h4>
                        <span
                          className={`rounded-full px-3 py-1 text-sm font-semibold ${a.this_week.met ? "bg-emerald-100 text-emerald-900" : "bg-slate-100 text-slate-900"}`}
                          data-count={a.id}
                        >
                          {t("count", { done: a.this_week.done, frequency: a.frequency_per_week })}
                        </span>
                      </div>
                      <p className="text-sm text-slate-700">{t("howOften", { count: a.frequency_per_week, minutes: a.duration_min })}</p>
                      {a.materials ? <p className="text-sm break-words text-slate-700">{t("materials", { materials: a.materials })}</p> : null}
                      <Instructions markdown={a.instructions_md} label={tf("instructions")} />
                      {a.guide ? (
                        <a
                          href={a.guide.download_url}
                          className="inline-flex min-h-11 items-center font-semibold text-teal-800 underline"
                          aria-label={t("guideLabel", { title: a.guide.title })}
                        >
                          {t("guide")}
                        </a>
                      ) : null}
                      <DoneToday
                        activityId={a.id}
                        activityTitle={a.title}
                        today={program.today}
                        ownLogs={ownLogs
                          .filter((l) => l.activity_id === a.id)
                          .map((l) => ({ id: l.id, done_on: l.done_on, difficulty: l.difficulty, duration_min: l.duration_min, note: l.note }))}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </section>
        ))
      )}
    </div>
  );
}
