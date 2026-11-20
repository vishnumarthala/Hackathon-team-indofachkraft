"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { SiteNav, type NavVariant } from "@/components/landing/SiteNav";
import { Logo } from "@/components/landing/ui";
import { isFamilyPath } from "@/lib/auth-access";
import { useT } from "@/lib/i18n/client";

// Marketing pages (landing, book a demo, login) render their own navigation; the family portal (019) its own header.
const MARKETING_PATHS = new Set(["/", "/for-centres", "/book-demo", "/login"]);
// Pages parents reach from the parents' home: the same navigation and footer as `/`, so the site feels like one.
const PARENT_PREFIXES = ["/screen", "/find", "/p/", "/c/", "/book", "/privacy", "/pay"];
// Provider sign-up: the same navigation in its centres variant.
const CENTRE_PREFIXES = ["/join"];
// Link-only pages (intake call, referral packet, invitations, claim links): logo and language only, no app links.
const LINK_PREFIXES = ["/intake", "/specialist", "/invite", "/claim"];

export type ChromeKind = "none" | "parents" | "centres" | "link" | "app";

// "/p/" matches only below it; "/screen" matches the page and everything below it.
const matches = (pathname: string, prefixes: string[]) =>
  prefixes.some((p) => (p.endsWith("/") ? pathname.startsWith(p) : pathname === p || pathname.startsWith(`${p}/`)));

export function chromeFor(pathname: string): ChromeKind {
  if (MARKETING_PATHS.has(pathname) || isFamilyPath(pathname)) return "none";
  if (matches(pathname, PARENT_PREFIXES)) return "parents";
  if (matches(pathname, CENTRE_PREFIXES)) return "centres";
  if (matches(pathname, LINK_PREFIXES)) return "link";
  return "app";
}

/**
 * Site header (and, on public pages, the footer) around every page. The yellow demo banner shows only in DEMO_MODE,
 * where "sample data only" is true; a real pilot deployment has no banner.
 */
export function SiteChrome({ children, demo, footer, fontVars }: { children?: ReactNode; demo: boolean; footer: ReactNode; fontVars: string }) {
  const pathname = usePathname();
  const t = useT();
  const kind = chromeFor(pathname);
  const banner = demo ? (
    <div role="note" className="bg-yellow-200 px-4 py-2 text-center text-sm font-medium text-yellow-950 print:hidden">
      {t("banner.pilot")}
    </div>
  ) : null;

  if (kind === "none") return <main className="flex-1">{children}</main>;

  if (kind === "parents" || kind === "centres") {
    const variant: NavVariant = kind;
    return (
      <div className={`lp-root ${fontVars} flex flex-1 flex-col`}>
        <SiteNav variant={variant} solid />
        <div aria-hidden="true" className="h-16 shrink-0 print:hidden" />
        {banner}
        <main className="flex-1">{children}</main>
        <div className="print:hidden">{footer}</div>
      </div>
    );
  }

  if (kind === "link") {
    return (
      <>
        <header className="border-b border-slate-200 bg-white print:hidden">
          <nav aria-label={t("nav.mainLabel")} className="mx-auto flex h-16 max-w-5xl items-center justify-between gap-4 px-4">
            <Link href="/" aria-label={t("nav.homeLabel")} className="shrink-0 rounded-lg">
              <Logo />
            </Link>
            <LanguageSwitcher className="text-slate-700" />
          </nav>
        </header>
        {banner}
        <main className="flex-1">{children}</main>
      </>
    );
  }

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
      {banner}
      <main className="flex-1">{children}</main>
    </>
  );
}
