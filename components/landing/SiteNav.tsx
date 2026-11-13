"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { useT } from "@/lib/i18n/client";
import { Arrow, Logo } from "./ui";

export type NavVariant = "parents" | "centres";

type NavLink = { href: string; label: string; current?: boolean; desktop: boolean };

/**
 * 050: `/` is the parents' home; `/for-centres` keeps the therapist / centre landing and its section links.
 * The desktop bar shows a short list (it must fit one line in en/hi/te at 1280 px); the mobile menu shows all.
 */
function navLinks(variant: NavVariant, t: ReturnType<typeof useT<"nav">>, find: string, checkIn: string): NavLink[] {
  const forCentres = { href: "/for-centres", label: t("forCentres"), current: variant === "centres", desktop: true };
  if (variant === "parents") {
    return [
      { href: "/#how-it-works", label: t("howItWorks"), desktop: true },
      { href: "/find", label: find, desktop: true },
      // The bar's call to action is the check-in, so the desktop list leaves it out.
      { href: "/screen", label: checkIn, desktop: false },
      forCentres,
    ];
  }
  return [
    { href: "/for-centres#problem", label: t("problem"), desktop: false },
    { href: "/for-centres#voice-demo", label: t("intakeCall"), desktop: true },
    { href: "/for-centres#how", label: t("howItWorks"), desktop: true },
    { href: "/for-centres#who", label: t("whoFor"), desktop: false },
    { href: "/for-centres#faq", label: t("faq"), desktop: true },
    { href: "/find", label: find, desktop: false },
    { href: "/screen", label: checkIn, desktop: false },
    forCentres,
    { href: "/", label: t("forParents"), desktop: true },
  ];
}

export function SiteNav({ overDark = false, variant = "parents" }: { overDark?: boolean; variant?: NavVariant }) {
  const ref = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const t = useT("nav");
  const td = useT("directory.landing");
  const ts = useT("screen.landing");
  const centres = variant === "centres";
  const links = navLinks(variant, t, td("find"), ts("navLink"));
  // Parents sign in to the family portal; centres to the provider workspace.
  const logInHref = centres ? "/login" : "/family/login";
  const cta = centres ? { href: "/book-demo", label: t("bookDemo") } : { href: "/screen", label: t("startCheckIn") };

  // Solid background once the page scrolls (class toggle, no re-render on scroll).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => el.classList.toggle("lp-nav-solid", window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <header ref={ref} data-over-dark={overDark || undefined} className={`lp-nav fixed inset-x-0 top-0 z-50 ${open ? "lp-nav-solid !bg-[#f8f6f1]" : ""}`}>
      <nav aria-label={t("mainLabel")} className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between gap-3 px-4 sm:gap-6 sm:px-6">
        <Link href="/" aria-label={t("homeLabel")} className="shrink-0 rounded-lg focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-600/30">
          <Logo />
        </Link>

        <ul className="hidden items-center gap-6 xl:flex">
          {links
            .filter((l) => l.desktop)
            .map((l) => (
              <li key={l.href}>
                <Link
                  href={l.href}
                  aria-current={l.current ? "page" : undefined}
                  className="lp-underline whitespace-nowrap text-[0.92rem] font-medium opacity-80 transition-opacity hover:opacity-100 aria-[current=page]:opacity-100"
                >
                  {l.label}
                </Link>
              </li>
            ))}
        </ul>

        <div className="ml-auto flex items-center gap-2">
          <LanguageSwitcher selectClassName="max-w-[7.5rem]" />
          <Link
            href={logInHref}
            className="lp-nav-ghost hidden whitespace-nowrap rounded-full px-4 py-2 text-[0.92rem] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-600/30 md:inline-flex"
          >
            {t("logIn")}
          </Link>
          <Link
            href={cta.href}
            className="lp-btn lp-nav-cta hidden min-h-10 items-center gap-1.5 whitespace-nowrap rounded-full px-5 py-2 text-[0.92rem] font-semibold focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-600/40 sm:inline-flex"
          >
            {cta.label}
            <Arrow className="h-3.5 w-3.5" />
          </Link>
        </div>

        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-controls="lp-mobile-menu"
          aria-label={open ? t("closeMenu") : t("openMenu")}
          className="lp-nav-ghost flex h-11 w-11 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-600/30 xl:hidden"
        >
          <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            {open ? <path d="M6 6l12 12M18 6 6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
          </svg>
        </button>
      </nav>

      <div
        id="lp-mobile-menu"
        className={`lp-menu border-t border-[#0b1f1d]/10 bg-[#f8f6f1] px-4 pb-6 pt-2 xl:hidden ${
          open ? "translate-y-0 opacity-100" : "pointer-events-none hidden -translate-y-2 opacity-0"
        }`}
      >
        <ul className="divide-y divide-[#0b1f1d]/10">
          {links.map((l) => (
            <li key={l.href}>
              <Link
                href={l.href}
                aria-current={l.current ? "page" : undefined}
                onClick={() => setOpen(false)}
                className="flex min-h-12 items-center text-base font-medium text-[#0b1f1d]"
              >
                {l.label}
              </Link>
            </li>
          ))}
        </ul>
        <div className="mt-4 grid grid-cols-2 gap-3">
          <Link href={logInHref} className="lp-btn flex min-h-12 items-center justify-center rounded-full border border-[#0b1f1d]/15 bg-white px-2 text-center font-semibold text-[#0b1f1d]">
            {t("logIn")}
          </Link>
          <Link href={cta.href} className="lp-btn flex min-h-12 items-center justify-center rounded-full bg-[#0b1f1d] px-2 text-center font-semibold text-white">
            {cta.label}
          </Link>
        </div>
      </div>
    </header>
  );
}
