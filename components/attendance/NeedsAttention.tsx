import Link from "next/link";
import { listNeedsAttention } from "@/lib/booking/attendance";
import { todayIn } from "@/lib/booking/time";
import { getFormatter, getT } from "@/lib/i18n/server";

/**
 * 044 FR-4 `Needs attention`: sessions that started more than 24 h ago and were never marked, each linking to the
 * register on its day. Self-contained (data + markup, renders nothing when the list is empty) so 052's provider
 * "Today" panel can drop it in: `<NeedsAttention userId={user.id} />`.
 */
export async function NeedsAttention({ userId, limit = 10 }: { userId: string; limit?: number }) {
  const { items, total } = await listNeedsAttention(userId, { limit });
  if (items.length === 0) return null;
  const t = await getT("attendance.needsAttention");
  const format = await getFormatter();
  return (
    <section aria-labelledby="needs-attention" className="space-y-3 rounded border border-amber-300 bg-amber-50 p-4" data-testid="needs-attention">
      <div>
        <h2 id="needs-attention" className="text-lg font-semibold text-slate-900">
          {t("title")}
        </h2>
        <p className="text-sm text-slate-800">{t("intro")}</p>
      </div>
      <ul className="divide-y divide-amber-200">
        {items.map((item) => (
          <li key={item.id} className="flex flex-col gap-1 py-2 text-sm sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="font-medium text-slate-900">{format.dateTime(item.starts_at)}</p>
              <p className="break-words text-slate-800">
                {t("item", { child: item.child_name ?? t("noChild"), service: item.service_name, therapist: item.provider_name })}
              </p>
            </div>
            {item.can_mark ? (
              <Link
                href={`/dashboard/register?org=${item.org_id}&date=${todayIn(format.timeZone, new Date(item.starts_at))}`}
                className="inline-flex min-h-11 items-center font-semibold text-teal-800 underline"
              >
                {t("open")}
              </Link>
            ) : (
              <p className="text-xs text-slate-700">{t("askAdmin")}</p>
            )}
          </li>
        ))}
      </ul>
      {total > items.length ? <p className="text-sm text-slate-700">{t("more", { count: total - items.length })}</p> : null}
    </section>
  );
}
