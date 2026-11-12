"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useT } from "@/lib/i18n/client";

export const FAMILY_NAV = [
  { href: "/family", key: "home" },
  { href: "/family/children", key: "children" },
  { href: "/family/appointments", key: "appointments" },
  { href: "/family/messages", key: "messages" },
  { href: "/family/documents", key: "documents" },
  { href: "/family/settings", key: "settings" },
] as const;

export function FamilyNav() {
  const t = useT("family.shell");
  const pathname = usePathname();
  return (
    <nav aria-label={t("navLabel")}>
      <ul className="flex flex-wrap gap-1 sm:gap-2">
        {FAMILY_NAV.map((item) => {
          const active = item.href === "/family" ? pathname === "/family" : pathname.startsWith(item.href);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`flex min-h-11 items-center justify-center rounded-lg px-3 text-center text-sm font-medium ${
                  active ? "bg-teal-50 text-teal-900" : "text-slate-700 hover:bg-slate-100"
                }`}
              >
                {t(item.key)}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
