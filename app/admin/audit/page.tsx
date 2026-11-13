import type { Metadata } from "next";
import Link from "next/link";
import { AdminNav } from "@/components/admin/AdminNav";
import { audit, auditActorOf } from "@/lib/audit";
import { cleanFilters, listAuditEvents, type AuditFilters } from "@/lib/audit/query";
import { requirePlatformAdminPage } from "@/lib/authz";
import { getFormatter, getT } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT("privacy.admin.audit");
  return { title: t("title") };
}

const short = (id: string | null) => (id ? id.slice(0, 8) : "");

// 041 FR-4: platform admin audit log (filters, keyset pages). Never shows `details`. Viewing is audited (`audit.viewed`).
// Other roles: 404 (like the other /admin pages).
export default async function AdminAuditPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const actor = await requirePlatformAdminPage();
  const filters = cleanFilters(await searchParams);
  const [t, format] = [await getT("privacy.admin.audit"), await getFormatter()];
  const { rows, nextBefore } = await listAuditEvents(filters);
  const { before: _before, ...applied } = filters;
  void _before;
  await audit({
    ...auditActorOf(actor.user, actor.role),
    action: "audit.viewed",
    entity: "audit_events",
    details: { filters: applied, rows: rows.length },
  });

  const field = (name: keyof AuditFilters, label: string, type = "text", hint?: string) => (
    <label className="flex flex-col gap-1 text-sm font-medium text-slate-800">
      {label}
      <input
        name={name}
        type={type}
        defaultValue={filters[name] ?? ""}
        placeholder={hint}
        className="min-h-11 rounded border border-slate-300 px-2 py-1 font-normal"
      />
    </label>
  );
  const nextQuery = nextBefore ? new URLSearchParams({ ...applied, before: nextBefore } as Record<string, string>).toString() : null;

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-6">
      <AdminNav current="audit" />
      <h1 className="text-2xl font-semibold text-slate-900">{t("title")}</h1>
      <p className="text-sm text-slate-700">{t("intro")}</p>
      <form method="get" className="grid grid-cols-1 gap-3 rounded border border-slate-200 bg-white p-4 sm:grid-cols-2 lg:grid-cols-4">
        {field("action", t("action"), "text", "consent.granted, privacy.*")}
        {field("actor", t("actor"), "text", t("actorHint"))}
        {field("org", t("organisation"))}
        {field("child", t("child"))}
        {field("case", t("case"))}
        {field("from", t("from"), "date")}
        {field("to", t("to"), "date")}
        <div className="flex items-end gap-3">
          <button type="submit" className="min-h-11 rounded bg-slate-900 px-4 font-semibold text-white">
            {t("filter")}
          </button>
          <Link href="/admin/audit" className="inline-flex min-h-11 items-center text-sm underline">
            {t("clear")}
          </Link>
        </div>
      </form>
      {rows.length === 0 ? (
        <p className="text-slate-700">{t("none")}</p>
      ) : (
        <div className="overflow-x-auto rounded border border-slate-200 bg-white">
          <table className="min-w-full text-left text-sm" data-testid="audit-table">
            <thead className="bg-slate-50 text-slate-700">
              <tr>
                {[t("time"), t("role"), t("actorId"), t("action"), t("entity"), t("ids")].map((h) => (
                  <th key={h} scope="col" className="px-3 py-2">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-slate-200 align-top">
                  <td className="px-3 py-2 whitespace-nowrap">{format.dateTime(r.created_at)}</td>
                  <td className="px-3 py-2 font-mono">{r.actor_role}</td>
                  <td className="px-3 py-2 font-mono" title={r.actor_user_id ?? ""}>
                    {short(r.actor_user_id)}
                  </td>
                  <td className="px-3 py-2 font-mono">{r.action}</td>
                  <td className="px-3 py-2 font-mono">
                    {r.entity ?? ""} {short(r.entity_id)}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-slate-600">
                    {r.case_ref ? <span className="block">case {short(r.case_ref)}</span> : null}
                    {r.child_id ? <span className="block">child {short(r.child_id)}</span> : null}
                    {r.org_id ? <span className="block">org {short(r.org_id)}</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {nextQuery ? (
        <Link href={`/admin/audit?${nextQuery}`} className="inline-flex min-h-11 items-center font-semibold underline">
          {t("older")}
        </Link>
      ) : null}
    </div>
  );
}
