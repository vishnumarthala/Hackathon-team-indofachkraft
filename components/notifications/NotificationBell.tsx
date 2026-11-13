import Link from "next/link";
import { getT } from "@/lib/i18n/server";
import { unreadCount } from "@/lib/notify/inbox";

/** FR-7 bell for the provider and family headers (server component; the list page refreshes it after reads). */
export async function NotificationBell({ userId, href }: { userId: string; href: string }) {
  const t = await getT("notifications");
  const count = await unreadCount(userId);
  const label = t("bellLabel", { count });
  return (
    <Link
      href={href}
      aria-label={label}
      title={label}
      data-testid="notification-bell"
      className="relative inline-flex min-h-11 min-w-11 items-center justify-center rounded-full text-slate-700 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-600/30"
    >
      <svg aria-hidden="true" viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path strokeLinecap="round" strokeLinejoin="round" d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
      </svg>
      {count > 0 ? (
        <span
          aria-hidden="true"
          className="absolute right-0.5 top-0.5 min-w-5 rounded-full bg-red-600 px-1 text-center text-xs font-semibold leading-5 text-white"
        >
          {count > 99 ? "99+" : count}
        </span>
      ) : null}
    </Link>
  );
}
