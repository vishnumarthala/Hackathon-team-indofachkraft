import Link from "next/link";
import { redirect } from "next/navigation";
import { SignOutButton } from "@/components/auth/SignOutButton";
import { getUserRole, requirePageUser } from "@/lib/auth";
import { getT } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  // Guardians have no provider workspace (proxy.ts redirects them too; this is the server-side backstop).
  const user = await requirePageUser();
  const role = await getUserRole(user.id);
  if (role === "guardian") redirect("/family");
  const t = await getT("providers.nav");

  return (
    <>
      <div className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-2">
          <p className="truncate text-sm text-slate-600">
            Signed in as <span className="font-medium text-slate-900">{user.email}</span>
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Link className="text-sm font-medium text-slate-700 underline" href="/dashboard/team">
              Team
            </Link>
            <Link className="text-sm font-medium text-slate-700 underline" href="/dashboard/profile">
              {t("profile")}
            </Link>
            {role === "platform_admin" ? (
              <>
                <Link className="text-sm font-medium text-slate-700 underline" href="/admin/verifications">
                  {t("verifications")}
                </Link>
                <Link className="text-sm font-medium text-slate-700 underline" href="/admin/providers">
                  {t("providers")}
                </Link>
                <Link className="text-sm font-medium text-slate-700 underline" href="/admin/users">
                  User accounts
                </Link>
              </>
            ) : null}
            <SignOutButton />
          </div>
        </div>
      </div>
      {children}
    </>
  );
}
