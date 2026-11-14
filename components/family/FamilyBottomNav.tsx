"use client";

// Ticket 052 FR-3 / NFR-3: the family portal's mobile bottom navigation (Figma "Bottom nav": Home, Children, Visits,
// Messages, Account). Below 640 px only (`sm:hidden`); desktop keeps the top nav. Fixed to the bottom, padded by the
// safe-area inset, 44 px targets, `aria-current` on the active item and the unread count in the Messages label.
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useT } from "@/lib/i18n/client";

type Key = "home" | "children" | "visits" | "messages" | "account";

const ICONS: Record<Key, ReactNode> = {
  home: (
    <>
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5" />
    </>
  ),
  children: (
    <>
      <circle cx="9" cy="7" r="3.5" />
      <path d="M2.5 20.5a6.5 6.5 0 0 1 13 0" />
      <circle cx="17.5" cy="9" r="2.5" />
      <path d="M17 14.5a5 5 0 0 1 4.5 5" />
    </>
  ),
  visits: (
    <>
      <rect x="3" y="4.5" width="18" height="16.5" rx="2" />
      <path d="M8 2.5v4M16 2.5v4M3 10h18" />
    </>
  ),
  messages: <path d="M21 14.5a2 2 0 0 1-2 2H8l-5 4.5V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z" />,
  account: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </>
  ),
};

export const FAMILY_BOTTOM_NAV: { href: string; key: Key; match: string[] }[] = [
  { href: "/family", key: "home", match: [] },
  { href: "/family/children", key: "children", match: ["/family/children", "/family/assessments", "/family/documents"] },
  { href: "/family/appointments", key: "visits", match: ["/family/appointments"] },
  { href: "/family/messages", key: "messages", match: ["/family/messages"] },
  { href: "/family/settings", key: "account", match: ["/family/settings", "/family/notifications"] },
];

export function bottomNavActive(pathname: string, item: { href: string; match: string[] }): boolean {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (item.href === "/family") return path === "/family";
  return item.match.some((m) => path === m || path.startsWith(`${m}/`));
}

export function FamilyBottomNav({ unread }: { unread: number }) {
  const t = useT("family.shell");
  const pathname = usePathname() ?? "";
  return (
    <nav
      aria-label={t("bottomNavLabel")}
      data-bottom-nav
      data-testid="family-bottom-nav"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-200 bg-white pb-[env(safe-area-inset-bottom)] shadow-[0_-1px_4px_rgba(15,23,42,0.06)] sm:hidden"
    >
      <ul className="mx-auto grid max-w-md grid-cols-5">
        {FAMILY_BOTTOM_NAV.map((item) => {
          const active = bottomNavActive(pathname, item);
          const badge = item.key === "messages" && unread > 0 ? (unread > 99 ? "99+" : String(unread)) : null;
          const label = badge ? `${t(item.key)}, ${t("unread", { count: unread })}` : t(item.key);
          return (
            <li key={item.key}>
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                aria-label={label}
                className={`relative flex min-h-14 flex-col items-center justify-center gap-0.5 px-1 py-1.5 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-600 ${
                  active ? "text-teal-800" : "text-slate-600 hover:text-slate-900"
                }`}
              >
                <span className="relative">
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 24 24"
                    className="h-6 w-6"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={active ? 2.2 : 1.8}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    {ICONS[item.key]}
                  </svg>
                  {badge ? (
                    <span
                      aria-hidden="true"
                      data-testid="messages-badge"
                      className="absolute -right-2.5 -top-1.5 min-w-5 rounded-full bg-red-600 px-1 text-center text-[11px] font-semibold leading-5 text-white"
                    >
                      {badge}
                    </span>
                  ) : null}
                </span>
                <span className="max-w-full truncate">{t(item.key)}</span>
                {active ? <span aria-hidden="true" className="absolute inset-x-4 top-0 h-0.5 rounded-full bg-teal-700" /> : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
