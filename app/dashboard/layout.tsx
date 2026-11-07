import Link from "next/link";
import { SignOutButton } from "@/components/auth/SignOutButton";
import { getUserRole, requirePageUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const user = await requirePageUser();
  const role = await getUserRole(user.id);

  return (
    <>
      <div className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-2">
          <p className="truncate text-sm text-slate-600">
            Signed in as <span className="font-medium text-slate-900">{user.email}</span>
          </p>
          <div className="flex items-center gap-3">
            {role === "admin" ? (
              <Link className="text-sm font-medium text-slate-700 underline" href="/admin/users">
                User accounts
              </Link>
            ) : null}
            <SignOutButton />
          </div>
        </div>
      </div>
      {children}
    </>
  );
}
