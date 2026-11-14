import Link from "next/link";
import { NextStepCard, VisitWhere, primaryAction, secondaryAction } from "@/components/family/home/NextStepCard";
import { requireGuardianPage } from "@/lib/authz";
import { ageLabel } from "@/lib/children/age";
import { appointmentHref, loadFamilyFacts, pickNextStep } from "@/lib/family/next-step";
import { getFormatter, getT, getTimeZone } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

const card = "rounded-2xl border border-slate-200 bg-white p-4 shadow-sm";
const link = "inline-flex min-h-11 items-center font-semibold text-teal-800 underline";
const UPCOMING = 3;

/** Avatar initials: first letters of the first and last word, ignoring bracketed notes such as "(synthetic)". */
function initials(name: string): string {
  const parts = name.replace(/\([^)]*\)/g, " ").trim().split(/\s+/).filter((p) => /^\p{L}/u.test(p));
  const letters = parts.length > 1 ? [parts[0], parts[parts.length - 1]] : parts;
  return letters.map((p) => Array.from(p)[0] ?? "").join("").toUpperCase() || "?";
}

// 052 FR-1/FR-2 (Figma /family — Home 15:11): greeting, ONE Next step card, then the children, upcoming visits,
// what the care team shared and quick links. Every list has an empty state with one action (FR-7).
export default async function FamilyHomePage() {
  const { user, profile } = await requireGuardianPage();
  const timeZone = await getTimeZone();
  const facts = await loadFamilyFacts(user.id, { timeZone });
  const step = pickNextStep(facts);
  const [t, tc, format] = [await getT("family.home"), await getT("family.children"), await getFormatter()];
  const names = facts.children.map((c) => c.name);
  const childList = new Intl.ListFormat(format.locale === "en" ? "en-IN" : format.locale, { style: "long", type: "conjunction" }).format(names);
  const upcoming = facts.visits.filter((v) => v.status === "confirmed").slice(0, UPCOMING);
  const nextVisitOf = (childId: string) => facts.visits.find((v) => v.child_id === childId && v.status === "confirmed") ?? null;

  return (
    <div className="space-y-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold break-words text-slate-900 sm:text-3xl">{t("greeting", { name: profile.display_name ?? t("there") })}</h1>
        <p className="text-slate-700">{names.length ? t("thisWeek", { children: childList }) : t("thisWeekNone")}</p>
      </header>

      <NextStepCard step={step} />

      <section aria-labelledby="children-heading" className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="children-heading" className="text-lg font-semibold text-slate-900">
            {t("children.title")}
          </h2>
          {facts.children.length ? (
            <Link href="/family/children" className={link}>
              {t("children.all")}
            </Link>
          ) : null}
        </div>
        {facts.children.length === 0 ? (
          <div className={`${card} space-y-3 border-dashed text-center text-slate-700`}>
            <p>{t("children.empty")}</p>
            <Link href="/family/children/new" className={secondaryAction}>
              {t("children.add")}
            </Link>
          </div>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2" data-testid="home-children">
            {facts.children.map((c) => {
              const next = nextVisitOf(c.id);
              return (
                <li key={c.id}>
                  <Link
                    href={`/family/children/${c.id}`}
                    aria-label={t("children.open", { name: c.name })}
                    className={`${card} flex min-h-11 gap-3 hover:border-teal-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600`}
                  >
                    <span aria-hidden="true" className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-teal-100 text-base font-bold text-teal-900">
                      {initials(c.name)}
                    </span>
                    <span className="min-w-0 space-y-0.5 text-sm text-slate-700">
                      <span className="block text-base font-semibold break-words text-slate-900">{c.name}</span>
                      <span className="block">{ageLabel(tc, c.date_of_birth)}</span>
                      <span className="block break-words">
                        {c.care_team.length ? t("children.careTeam", { names: c.care_team.slice(0, 2).join(", ") }) : t("children.noTeam")}
                      </span>
                      <span className="block">{next ? t("children.nextVisit", { when: format.dateTime(next.starts_at) }) : t("children.noVisit")}</span>
                      {c.home.activities ? (
                        <span className="block font-medium text-teal-900" data-testid="home-streak">
                          {c.home.streak ? t("children.streak", { count: c.home.streak }) : t("children.noStreak")}
                        </span>
                      ) : null}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
        {facts.children.length ? (
          <div className="flex flex-col gap-2 sm:flex-row">
            <Link href="/family/children/new" className={secondaryAction}>
              {t("addAnother")}
            </Link>
            <Link href="/family/children/claim" className={secondaryAction}>
              {t("useCode")}
            </Link>
          </div>
        ) : null}
      </section>

      <section aria-labelledby="visits-heading" className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="visits-heading" className="text-lg font-semibold text-slate-900">
            {t("visits.title")}
          </h2>
          <Link href="/family/appointments" className={link}>
            {t("visits.all")}
          </Link>
        </div>
        {upcoming.length === 0 ? (
          <div className={`${card} space-y-3 border-dashed text-center text-slate-700`}>
            <p>{t("visits.empty")}</p>
            <Link href="/find" className={primaryAction}>
              {t("visits.find")}
            </Link>
          </div>
        ) : (
          <ul className="space-y-3" data-testid="home-visits">
            {upcoming.map((v) => (
              <li key={v.id} className={`${card} space-y-2`}>
                <div className="flex flex-wrap items-center gap-2">
                  {facts.children.length > 1 ? <span className="text-sm font-semibold text-slate-900">{v.child_name}</span> : null}
                  {v.series_id ? <span className="rounded-full bg-indigo-50 px-3 py-0.5 text-xs font-semibold text-indigo-900">{t("visits.weekly")}</span> : null}
                </div>
                <VisitWhere visit={v} />
                <Link href={appointmentHref(v.id)} className={link}>
                  {t("visits.details")}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="updates-heading" className="space-y-3">
        <h2 id="updates-heading" className="text-lg font-semibold text-slate-900">
          {t("updates.title")}
        </h2>
        {facts.updates.length === 0 ? (
          <div className={`${card} space-y-3 border-dashed text-center text-slate-700`}>
            <p>{t("updates.empty")}</p>
            <Link href="/family/messages" className={secondaryAction}>
              {t("updates.messages")}
            </Link>
          </div>
        ) : (
          <ul className="space-y-2" data-testid="home-updates">
            {facts.updates.map((u) => (
              <li key={`${u.kind}-${u.href}-${u.published_at}`}>
                <Link href={u.href} className={`${card} block min-h-11 hover:border-teal-600`}>
                  <span className="block font-semibold text-slate-900">
                    {t(`updates.kinds.${u.kind}`)}
                    {facts.children.length > 1 ? ` · ${u.child_name}` : ""}
                  </span>
                  <span className="block text-sm text-slate-600">{t("updates.from", { centre: u.org_name, date: format.date(u.published_at, "long") })}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="quick-heading" className="space-y-3">
        <h2 id="quick-heading" className="text-lg font-semibold text-slate-900">
          {t("quick.title")}
        </h2>
        <ul className="grid gap-2 sm:grid-cols-2">
          {(
            [
              ["/find", "find"],
              ["/screen", "checkin"],
              ["/family/assessments", "assessments"],
              ["/family/documents", "documents"],
            ] as const
          ).map(([href, key]) => (
            <li key={key}>
              <Link href={href} className={`${card} flex min-h-11 items-center font-semibold text-teal-900 hover:border-teal-600`}>
                {t(`quick.${key}`)}
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
