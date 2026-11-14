import Link from "next/link";
import type { ReactNode } from "react";
import { FamilyBottomNav } from "@/components/family/FamilyBottomNav";
import { FamilyNav } from "@/components/family/FamilyNav";
import { FamilySignOutButton } from "@/components/family/FamilySignOutButton";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { NotificationBell } from "@/components/notifications/NotificationBell";
import { requireGuardianPage } from "@/lib/authz";
import { familyUnreadCount } from "@/lib/family/next-step";

export const dynamic = "force-dynamic";

// FR-6 portal shell. Every page below also calls requireGuardianPage() itself (layouts are not a gate).
// 052 FR-3: below 640 px the top nav gives way to the bottom nav (Home, Children, Visits, Messages, Account).
export default async function FamilyPortalLayout({ children }: { children: ReactNode }) {
  const { user, profile } = await requireGuardianPage();
  const unread = await familyUnreadCount(user.id);
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
          <div className="hidden sm:block">
            <FamilyNav />
          </div>
        </div>
      </header>
      <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:py-8">{children}</div>
      <FamilyBottomNav unread={unread} />
    </>
  );
}
