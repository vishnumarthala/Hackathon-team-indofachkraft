import Link from "next/link";
import { notFound } from "next/navigation";
import { getUserRole, requirePageUser } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/db";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

function validPage(value: string | undefined): number {
  const page = Number(value);
  return Number.isInteger(page) && page > 0 ? page : 1;
}

export default async function UserAccountsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const currentUser = await requirePageUser();
  if ((await getUserRole(currentUser.id)) !== "admin") notFound();

  const { page: pageParam } = await searchParams;
  const page = validPage(pageParam);
  const { data, error } = await supabaseAdmin().auth.admin.listUsers({ page, perPage: PAGE_SIZE + 1 });
  if (error) throw new Error(`Could not load user accounts: ${error.message}`);
  const users = data.users.slice(0, PAGE_SIZE);

  const roles = new Map<string, string>();
  if (users.length > 0) {
    const profiles = await supabaseAdmin()
      .from("user_profiles")
      .select("id, role")
      .in("id", users.map((user) => user.id));
    if (profiles.error) throw new Error(`Could not load user roles: ${profiles.error.message}`);
    for (const profile of profiles.data) roles.set(profile.id, profile.role);
  }
  if (users.some((user) => !roles.has(user.id))) {
    throw new Error("Could not load a role for every user account");
  }
  const hasNextPage = data.users.length > PAGE_SIZE;

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8">
      <Link className="mb-4 inline-block text-sm text-slate-700 underline" href="/dashboard">
        Back to dashboard
      </Link>
      <h1 className="mb-2 text-3xl font-bold text-slate-900">User accounts</h1>
      <p className="mb-6 text-sm text-slate-600">
        Account directory · page {page} · {users.length} accounts shown
      </p>

      {users.length === 0 ? (
        <p className="rounded border border-slate-200 bg-white p-4 text-slate-700">No accounts on this page.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-200">
          <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
            <thead className="bg-slate-50">
              <tr>
                {["Email", "Role", "Email status", "Created", "Last sign in"].map((heading) => (
                  <th key={heading} className="px-3 py-2 font-semibold text-slate-900" scope="col">
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {users.map((user) => (
                <tr key={user.id}>
                  <td className="px-3 py-2">{user.email ?? "No email"}</td>
                  <td className="px-3 py-2">{roles.get(user.id)}</td>
                  <td className="px-3 py-2">{user.email_confirmed_at ? "Confirmed" : "Unconfirmed"}</td>
                  <td className="whitespace-nowrap px-3 py-2">{user.created_at}</td>
                  <td className="whitespace-nowrap px-3 py-2">{user.last_sign_in_at ?? "Never"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <nav aria-label="User account pages" className="mt-4 flex justify-between">
        {page > 1 ? (
          <Link className="text-sm font-medium text-slate-700 underline" href={`/admin/users?page=${page - 1}`}>
            Previous page
          </Link>
        ) : (
          <span />
        )}
        {hasNextPage ? (
          <Link className="text-sm font-medium text-slate-700 underline" href={`/admin/users?page=${page + 1}`}>
            Next page
          </Link>
        ) : null}
      </nav>
    </main>
  );
}
