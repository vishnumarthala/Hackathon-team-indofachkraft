import { notFound } from "next/navigation";
import { formatBerlin, PILOT_ROLE_LABELS } from "@/lib/pilots";
import { listPilotSignups } from "@/lib/queries/pilots";
import { getUserRole, requirePageUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function PilotSignupsPage() {
  const user = await requirePageUser();
  if ((await getUserRole(user.id)) !== "admin") notFound();

  const rows = await listPilotSignups();

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8">
      <h1 className="mb-1 text-3xl font-bold text-slate-900">Pilot sign-ups</h1>
      <p className="mb-6 text-slate-700">{rows.length} sign-ups</p>

      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
          <thead className="bg-slate-50">
            <tr>
              {["Name", "Email", "Role", "Country", "Centre", "Clinicians", "Date"].map((h) => (
                <th key={h} scope="col" className="px-3 py-2 font-semibold text-slate-900">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 bg-white">
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="px-3 py-2">{r.name}</td>
                <td className="px-3 py-2">{r.email}</td>
                <td className="px-3 py-2">{PILOT_ROLE_LABELS[r.role] ?? r.role}</td>
                <td className="px-3 py-2">{r.country}</td>
                <td className="px-3 py-2">{r.centre ?? ""}</td>
                <td className="px-3 py-2">{r.clinicians ?? ""}</td>
                <td className="whitespace-nowrap px-3 py-2">{formatBerlin(r.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
