"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { isFamilyPath } from "@/lib/auth-access";
import { useT } from "@/lib/i18n/client";

// Marketing pages (landing, book a demo, login) have their own navigation and no app banner.
const MARKETING_PATHS = new Set(["/", "/book-demo", "/login"]);

export function SiteChrome() {
  const pathname = usePathname();
  const t = useT();
  // The family portal (019) renders its own header.
  if (MARKETING_PATHS.has(pathname) || isFamilyPath(pathname)) return null;

  return (
    <>
      <header className="border-b border-slate-200 bg-white print:hidden">
        <nav
          aria-label={t("nav.mainLabel")}
          className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3"
        >
          <Link href="/" className="flex items-baseline gap-2 text-lg font-semibold text-slate-900">
            DoctorNearMe
            <span className="hidden text-sm font-medium text-slate-500 sm:inline">{t("nav.childDevelopment")}</span>
          </Link>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <Link href="/dashboard" className="text-sm font-medium text-slate-700 hover:text-slate-900">
              {t("nav.dashboard")}
            </Link>
            <Link href="/login" className="text-sm font-medium text-slate-700 hover:text-slate-900">
              {t("nav.signIn")}
            </Link>
            <LanguageSwitcher className="text-slate-700" />
          </div>
        </nav>
      </header>
      <div role="note" className="bg-yellow-200 px-4 py-2 print:hidden text-center text-sm font-medium text-yellow-950">
        {t("banner.pilot")}
      </div>
    </>
  );
}
