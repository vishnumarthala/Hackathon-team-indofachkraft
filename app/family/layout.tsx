import type { Metadata } from "next";
import type { ReactNode } from "react";
import { getT } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT("family.meta");
  return { title: t("title"), robots: { index: false, follow: false } };
}

// Shared by the sign-in page and the portal: the emergency line is always visible (FR-6).
// No third-party scripts on any /family page (NFR-2, enforced by the CSP in proxy.ts).
export default async function FamilyLayout({ children }: { children: ReactNode }) {
  const t = await getT("family.shell");
  return (
    <div className="flex min-h-screen flex-col bg-slate-50">
      <div className="flex-1">{children}</div>
      <footer className="border-t border-red-200 bg-red-50 px-4 py-3 text-center text-sm font-semibold text-red-900">
        <p role="note">{t("emergency")}</p>
      </footer>
    </div>
  );
}
