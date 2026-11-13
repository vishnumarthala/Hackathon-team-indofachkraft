import type { Metadata } from "next";
import Link from "next/link";
import { PolicyForm } from "@/components/attendance/PolicyForm";
import { RegisterClient } from "@/components/attendance/RegisterClient";
import { requireProviderPage } from "@/lib/authz";
import { loadRegister } from "@/lib/booking/attendance";
import { addDays } from "@/lib/booking/time";
import { getFormatter, getT } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT("attendance.register");
  return { title: `${t("title")} | DoctorNearMe`, robots: { index: false } };
}

type Props = { searchParams: Promise<{ org?: string; date?: string }> };

// 044 FR-3: the daily attendance register. Owner/admin see every session of the organisation; members their own
// (sessions of the provider profile bound to them) and only the last 7 days. The organisation comes from the user's
// own memberships (an unknown `org` falls back to the first one), never from trust in the query string.
export default async function RegisterPage({ searchParams }: Props) {
  const { user } = await requireProviderPage();
  const t = await getT("attendance");
  const format = await getFormatter();
  const sp = await searchParams;
  const register = await loadRegister(user.id, { orgId: sp.org ?? null, date: sp.date ?? null, timeZone: format.timeZone });

  if (!register) {
    return (
      <div className="mx-auto max-w-5xl space-y-4 px-4 py-6">
        <h1 className="text-2xl font-semibold text-slate-900">{t("register.title")}</h1>
        <p className="text-slate-700">
          <Link href="/dashboard/team" className="underline">
            {t("register.noOrg")}
          </Link>
        </p>
      </div>
    );
  }

  const { org, orgs, date, today, minDate, rows, policy } = register;
  const href = (d: string) => `/dashboard/register?org=${org.id}&date=${d}`;
  const previous = addDays(date, -1);
  const charged = (on: boolean) => (on ? t("policy.charged") : t("policy.notCharged"));

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold text-slate-900">{t("register.title")}</h1>
        <p className="text-slate-700">{t("register.intro")}</p>
        <p className="text-sm font-medium text-slate-800">
          {org.manage ? t("register.allSessions", { org: org.name }) : t("register.yourSessions", { org: org.name })}
        </p>
        {!org.manage ? <p className="text-sm text-slate-600">{t("register.memberWindow")}</p> : null}
      </header>

      <form method="get" action="/dashboard/register" className="flex flex-wrap items-end gap-3">
        {orgs.length > 1 ? (
          <div>
            <label htmlFor="register-org" className="block text-sm font-medium text-slate-800">
              {t("register.org")}
            </label>
            <select id="register-org" name="org" defaultValue={org.id} className="mt-1 block min-h-11 rounded border border-slate-300 bg-white px-3 py-2 text-base sm:text-sm">
              {orgs.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <input type="hidden" name="org" value={org.id} />
        )}
        <div>
          <label htmlFor="register-date" className="block text-sm font-medium text-slate-800">
            {t("register.date")}
          </label>
          <input
            id="register-date"
            type="date"
            name="date"
            defaultValue={date}
            max={today}
            min={minDate ?? undefined}
            className="mt-1 block min-h-11 rounded border border-slate-300 bg-white px-3 py-2 text-base sm:text-sm"
          />
        </div>
        <button type="submit" className="inline-flex min-h-11 items-center rounded border border-slate-300 bg-white px-4 text-sm font-medium text-slate-900 hover:bg-slate-50">
          {t("register.show")}
        </button>
        {!minDate || previous >= minDate ? (
          <Link href={href(previous)} className="inline-flex min-h-11 items-center rounded border border-slate-300 bg-white px-4 text-sm font-medium text-slate-900">
            {t("register.previousDay")}
          </Link>
        ) : null}
        {date !== today ? (
          <Link href={href(today)} className="inline-flex min-h-11 items-center rounded border border-slate-300 bg-white px-4 text-sm font-medium text-slate-900">
            {t("register.today")}
          </Link>
        ) : null}
      </form>

      <h2 className="text-lg font-semibold text-slate-900">{format.date(`${date}T12:00:00Z`, "long")}</h2>
      <RegisterClient
        key={`${org.id}:${date}`}
        rows={rows.map((r) => ({
          id: r.id,
          starts_at: r.starts_at,
          ends_at: r.ends_at,
          status: r.status,
          attendance: r.attendance,
          billable: r.billable,
          child_name: r.child_name,
          case_id: r.case_id,
          provider_profile_id: r.provider_profile_id,
          provider_name: r.provider_name,
          service_name: r.service_name,
          mode: r.mode,
          series_id: r.series_id,
        }))}
        manage={org.manage}
        now={new Date().toISOString()}
      />

      <section aria-labelledby="attendance-policy" className="space-y-3 rounded border border-slate-200 bg-white p-4">
        <h2 id="attendance-policy" className="text-lg font-semibold text-slate-900">
          {t("policy.title")}
        </h2>
        <p className="text-sm text-slate-700">{t("policy.intro")}</p>
        <p className="text-sm text-slate-800" data-testid="policy-summary">
          {t("policy.summary", { absent: charged(policy.bill_absent), late: charged(policy.bill_late_cancel), hours: policy.late_cancel_hours })}
        </p>
        {org.manage ? <PolicyForm orgId={org.id} policy={policy} /> : <p className="text-sm text-slate-600">{t("policy.readOnly")}</p>}
      </section>
    </div>
  );
}
