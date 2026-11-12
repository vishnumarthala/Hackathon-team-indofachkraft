"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Marketing pages (landing, book a demo, login) have their own navigation and no app banner.
const MARKETING_PATHS = new Set(["/", "/book-demo", "/login"]);

export function SiteChrome() {
  const pathname = usePathname();
  if (MARKETING_PATHS.has(pathname)) return null;

  return (
    <>
      <header className="border-b border-slate-200 bg-white">
        <nav className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-3">
          <Link href="/" className="flex items-baseline gap-2 text-lg font-semibold text-slate-900">
            DoctorNearMe
            <span className="text-sm font-medium text-slate-500">Child Development</span>
          </Link>
          <Link href="/dashboard" className="text-sm font-medium text-slate-700 hover:text-slate-900">
            Dashboard
          </Link>
          <Link href="/login" className="text-sm font-medium text-slate-700 hover:text-slate-900">
            Sign in
          </Link>
        </nav>
      </header>
      <div role="note" className="bg-yellow-200 px-4 py-2 text-center text-sm font-medium text-yellow-950">
        Authenticated pilot - synthetic data only; do not enter real patient information. AI documents, the clinician decides.
      </div>
    </>
  );
}
