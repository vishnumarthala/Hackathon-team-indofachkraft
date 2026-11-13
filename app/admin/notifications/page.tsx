import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { RetryButton } from "@/components/notifications/RetryButton";
import { getUserRole, requirePageUser } from "@/lib/auth";
import { homeForRole } from "@/lib/auth-access";
import { getFormatter, getT } from "@/lib/i18n/server";
import { adminOverview } from "@/lib/notify/inbox";
import { CHANNELS, NOTIFICATION_STATUSES } from "@/lib/notify/types";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT("notifications.admin");
  return { title: t("title") };
}

// FR-9 ops view for platform admins: counts, last 50 failed/dead deliveries (metadata and error only, never the
// message text) and `Retry`. Everyone else is sent to their own home.
export default async function AdminNotificationsPage() {
  const user = await requirePageUser();
  const role = await getUserRole(user.id);
  if (role !== "platform_admin") redirect(homeForRole(role));
  const t = await getT("notifications.admin");
  const nav = await getT();
  const format = await getFormatter();
  const { counts, events, problems } = await adminOverview();

  return (
    <div className="mx-auto max-w-5xl space-y-8 px-4 py-6">
      <nav className="flex flex-wrap gap-4 text-sm">
        <Link href="/dashboard" className="font-medium text-slate-700 underline">
          {nav("nav.dashboard")}
        </Link>
      </nav>
      <h1 className="text-2xl font-semibold text-slate-900">{t("title")}</h1>

      <section aria-labelledby="counts-heading" className="space-y-3">
        <h2 id="counts-heading" className="text-lg font-semibold text-slate-900">
          {t("counts")}
        </h2>
        <div className="overflow-x-auto rounded border border-slate-200 bg-white">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-left text-slate-700">
              <tr>
                <th scope="col" className="px-3 py-2">{t("channel")}</th>
                {NOTIFICATION_STATUSES.map((s) => (
                  <th key={s} scope="col" className="px-3 py-2 font-mono font-medium">{s}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {CHANNELS.map((c) => (
                <tr key={c} className="border-t border-slate-200">
                  <th scope="row" className="px-3 py-2 text-left font-mono font-medium">{c}</th>
                  {NOTIFICATION_STATUSES.map((s) => (
                    <td key={s} className="px-3 py-2 tabular-nums" data-testid={`count-${c}-${s}`}>
                      {format.number(counts[c][s])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-sm text-slate-700">
          {t("events")}:{" "}
          {["pending", "fanned_out", "cancelled"].map((s) => `${s} ${format.number(events[s] ?? 0)}`).join(" · ")}
        </p>
      </section>

      <section aria-labelledby="problems-heading" className="space-y-3">
        <h2 id="problems-heading" className="text-lg font-semibold text-slate-900">
          {t("problems")}
        </h2>
        {problems.length === 0 ? (
          <p className="text-slate-700">{t("none")}</p>
        ) : (
          <ul className="space-y-3" data-testid="notification-problems">
            {problems.map((p) => (
              <li key={p.id} className="grid gap-2 rounded border border-slate-200 bg-white p-3 text-sm md:grid-cols-[1fr_auto]">
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                  <dt className="text-slate-600">{t("topic")}</dt>
                  <dd className="font-mono">{p.topic} / {p.template}</dd>
                  <dt className="text-slate-600">{t("channel")}</dt>
                  <dd className="font-mono">{p.channel}</dd>
                  <dt className="text-slate-600">{t("status")}</dt>
                  <dd className="font-mono">{p.status}</dd>
                  <dt className="text-slate-600">{t("attempts")}</dt>
                  <dd>{format.number(p.attempts)}</dd>
                  <dt className="text-slate-600">{t("error")}</dt>
                  <dd className="break-words font-mono">{p.last_error ?? "-"}</dd>
                  <dt className="text-slate-600">{t("lastAttempt")}</dt>
                  <dd>{p.last_attempt_at ? format.dateTime(p.last_attempt_at) : "-"}</dd>
                  {p.status === "failed" ? (
                    <>
                      <dt className="text-slate-600">{t("nextAttempt")}</dt>
                      <dd>{format.dateTime(p.next_attempt_at)}</dd>
                    </>
                  ) : null}
                </dl>
                {p.status === "dead" ? <RetryButton id={p.id} /> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
