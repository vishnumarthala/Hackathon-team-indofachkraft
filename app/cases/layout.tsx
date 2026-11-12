import { SignOutButton } from "@/components/auth/SignOutButton";
import { requireProviderPage } from "@/lib/authz";

export const dynamic = "force-dynamic";

export default async function CasesLayout({ children }: { children: React.ReactNode }) {
  const { user } = await requireProviderPage();

  return (
    <>
      <div className="border-b border-slate-200 bg-white print:hidden">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-2">
          <p className="truncate text-sm text-slate-600">
            Signed in as <span className="font-medium text-slate-900">{user.email}</span>
          </p>
          <SignOutButton />
        </div>
      </div>
      {children}
    </>
  );
}
