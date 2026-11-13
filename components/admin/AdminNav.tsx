import Link from "next/link";
import { getT } from "@/lib/i18n/server";

const LINKS = [
  { href: "/admin/users", key: "users" },
  { href: "/admin/audit", key: "audit" },
  { href: "/admin/privacy/requests", key: "requests" },
  { href: "/admin/ops", key: "ops" },
  { href: "/admin/notifications", key: "notifications" },
] as const;

// 041: platform admin navigation for the privacy/audit/ops pages.
export async function AdminNav({ current }: { current: (typeof LINKS)[number]["key"] }) {
  const t = await getT("privacy.admin.nav");
  return (
    <nav aria-label="Admin" className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
      {LINKS.map((l) => (
        <Link
          key={l.key}
          href={l.href}
          aria-current={l.key === current ? "page" : undefined}
          className={`inline-flex min-h-11 items-center underline ${l.key === current ? "font-semibold text-slate-900" : "text-slate-700"}`}
        >
          {t(l.key)}
        </Link>
      ))}
    </nav>
  );
}
