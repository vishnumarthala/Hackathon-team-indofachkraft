import Link from "next/link";
import { ReportPreview } from "@/components/report/ReportEditor";
import { requireChildGuardianPage, requireGuardianPage } from "@/lib/authz";
import { isCitedEntityType } from "@/lib/followup/constants";
import { loadGuardianDocs } from "@/lib/followup/context";
import { getFormatter, getT, getTimeZone } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

type Params = { id: string; type: string; entityId: string; version: string };

// Ticket 040 FR-4: a citation chip opens the cited published document. Only documents the follow-up agent may use
// for this guardian and child (lib/followup/context.ts, design rule 9) are shown, at their current guardian-visible
// version: the cited version when it is still current, else the current one with a note. Withdrawn, cancelled or
// foreign documents show "not shared with you" (the child itself is checked first: other children 404).
export default async function FollowupSourcePage({ params }: { params: Promise<Params> }) {
  await requireGuardianPage();
  const { id, type, entityId, version } = await params;
  const { child, session } = await requireChildGuardianPage(id);
  const [t, format] = [await getT("followup"), await getFormatter()];
  const docs = isCitedEntityType(type) ? ((await loadGuardianDocs(session.user.id, child.id, { timeZone: await getTimeZone() })) ?? []) : [];
  const doc = docs.find((d) => d.entity_type === type && d.entity_id === entityId) ?? null;
  const cited = Number(version);

  return (
    <div className="space-y-6">
      <Link href={`/family/children/${child.id}/ask`} className="inline-flex min-h-11 items-center text-sm font-semibold text-teal-800 underline">
        {t("source.back")}
      </Link>
      {doc ? (
        <article className="space-y-3" data-testid="followup-source" data-entity-type={doc.entity_type} data-version={doc.version}>
          <header className="space-y-1">
            <h1 className="text-2xl font-bold break-words text-slate-900" lang="en">
              {doc.label}
            </h1>
            <p className="text-sm text-slate-600">
              {t("source.from", { org: doc.org_name })} · {t("source.sharedOn", { date: format.date(doc.published_at, "long") })} ·{" "}
              {t("source.version", { version: doc.version })}
            </p>
          </header>
          {doc.version !== cited ? (
            <p role="status" className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-amber-950" data-testid="followup-source-updated">
              {t("source.updated", { version: doc.version })}
            </p>
          ) : null}
          <div lang="en">
            <ReportPreview markdown={doc.content} />
          </div>
        </article>
      ) : (
        <p role="status" className="rounded-2xl border border-slate-200 bg-white p-4 text-slate-800" data-testid="followup-source-missing">
          {t("source.notAvailable")}
        </p>
      )}
    </div>
  );
}
