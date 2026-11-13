import Link from "next/link";
import { notFound } from "next/navigation";
import { HealthProfileView } from "@/components/health/HealthProfileView";
import { requireChildGuardianPage, requireGuardianPage } from "@/lib/authz";
import { getFormatter, getT } from "@/lib/i18n/server";
import { getHealthHistoryVersion } from "@/lib/queries/health";

export const dynamic = "force-dynamic";

// 021 FR-6: one past version, read only (no form, no save).
export default async function ChildHealthVersionPage({ params }: { params: Promise<{ id: string; version: string }> }) {
  await requireGuardianPage();
  const { id, version } = await params;
  const { child } = await requireChildGuardianPage(id);
  if (!/^\d{1,9}$/.test(version)) notFound();
  const found = await getHealthHistoryVersion(child.id, Number(version));
  if (!found) notFound();
  const [th, format] = await Promise.all([getT("health.history"), getFormatter()]);
  const date = format.dateTime(found.entry.changed_at);

  return (
    <div className="space-y-6">
      <Link
        href={`/family/children/${child.id}/health/history`}
        className="inline-flex min-h-11 items-center text-sm font-semibold text-teal-800 underline"
      >
        {th("backToHistory")}
      </Link>
      <header className="space-y-1">
        <h1 className="text-2xl font-bold break-words text-slate-900 sm:text-3xl">{th("version", { version: found.entry.version })}</h1>
        <p className="text-slate-700">
          {found.entry.changed_by_name ? th("savedBy", { date, name: found.entry.changed_by_name }) : th("savedOn", { date })}
        </p>
        <p role="note" className="rounded-2xl bg-amber-50 p-4 text-amber-950">
          {th("readOnly")}
        </p>
      </header>
      <HealthProfileView profile={found.profile} />
    </div>
  );
}
