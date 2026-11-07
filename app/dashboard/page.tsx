import Link from "next/link";
import { StatusBadge } from "@/components/case/StatusBadge";
import { ageLabel, formatDateTime, languageName } from "@/lib/cases/format";
import { listCases } from "@/lib/queries/cases";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const cases = await listCases();

  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Cases</h1>
        <Link href="/cases/new" className="rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white">
          New case
        </Link>
      </div>

      {cases.length === 0 ? (
        <p className="text-slate-600">No cases yet. Create the first one.</p>
      ) : (
        <div className="max-w-full overflow-x-auto rounded border border-slate-200">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-slate-50 text-slate-700">
              <tr>
                <th className="px-3 py-2 font-medium">Child</th>
                <th className="px-3 py-2 font-medium">Age</th>
                <th className="px-3 py-2 font-medium">Language</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Created</th>
              </tr>
            </thead>
            <tbody>
              {cases.map((c) => (
                <tr key={c.id} className="border-t border-slate-200">
                  <td className="px-3 py-2">
                    <Link href={`/cases/${c.id}`} className="font-medium text-slate-900 underline">
                      {c.child_alias}
                    </Link>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">{ageLabel(c.child_age_months)}</td>
                  <td className="px-3 py-2">{languageName(c.language)}</td>
                  <td className="px-3 py-2">
                    <StatusBadge status={c.status} />
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">{formatDateTime(c.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
