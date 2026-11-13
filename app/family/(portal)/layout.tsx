import Link from "next/link";
import type { ReactNode } from "react";
import { FamilyNav } from "@/components/family/FamilyNav";
import { FamilySignOutButton } from "@/components/family/FamilySignOutButton";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { NotificationBell } from "@/components/notifications/NotificationBell";
import { requireGuardianPage } from "@/lib/authz";

export const dynamic = "force-dynamic";

// FR-6 portal shell. Every page below also calls requireGuardianPage() itself (layouts are not a gate).
export default async function FamilyPortalLayout({ children }: { children: ReactNode }) {
  const { user, profile } = await requireGuardianPage();
  return (
    <>
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-4xl flex-col gap-3 px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <Link href="/family" className="flex min-h-11 items-center text-lg font-semibold text-slate-900">
              DoctorNearMe
            </Link>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              {profile.display_name ? (
                <span className="max-w-[12rem] truncate text-sm font-medium text-slate-700" data-testid="family-display-name">
                  {profile.display_name}
                </span>
              ) : null}
              <NotificationBell userId={user.id} href="/family/notifications" />
              <LanguageSwitcher className="text-slate-700" />
              <FamilySignOutButton />
            </div>
          </div>
          <FamilyNav />
        </div>
      </header>
      <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:py-8">{children}</div>
    </>
  );
}
