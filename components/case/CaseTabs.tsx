"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useT } from "@/lib/i18n/client";

const TABS = [
  { key: "overview", segment: "" },
  { key: "brief", segment: "brief" },
  { key: "sessions", segment: "sessions" },
  { key: "report", segment: "report" },
  { key: "referral", segment: "referral" },
  { key: "documents", segment: "documents" },
  { key: "assessments", segment: "assessments" },
  { key: "goals", segment: "goals" },
  { key: "homeProgram", segment: "home-program" },
  // 044 FR-6: monthly attendance calendar + CSV export.
  { key: "attendance", segment: "attendance" },
  // 045 FR-7: balance, package, ledger, payment links / QR.
  { key: "fees", segment: "fees" },
  // 039: verified prescribers only (decided on the server, see app/cases/[id]/layout.tsx).
  { key: "prescriptions", segment: "prescriptions", prescriberOnly: true },
  { key: "team", segment: "team" },
  { key: "health", segment: "health" },
  { key: "shared", segment: "shared" },
  { key: "messages", segment: "messages" },
] as const;

export function isTabActive(pathname: string, base: string, segment: string): boolean {
  const path = pathname.replace(/\/+$/, "");
  if (!segment) return path === base;
  const href = `${base}/${segment}`;
  return path === href || path.startsWith(`${href}/`);
}

export function CaseTabs({ caseId, showPrescriptions = false }: { caseId: string; showPrescriptions?: boolean }) {
  const t = useT("caseTabs");
  const pathname = usePathname() ?? "";
  const base = `/cases/${caseId}`;
  return (
    <nav aria-label={t("label")} className="-mb-px flex gap-1 overflow-x-auto border-b border-slate-200">
      {TABS.filter((tab) => showPrescriptions || !("prescriberOnly" in tab)).map((tab) => {
        const href = tab.segment ? `${base}/${tab.segment}` : base;
        const active = isTabActive(pathname, base, tab.segment);
        return (
          <Link
            key={tab.key}
            href={href}
            aria-current={active ? "page" : undefined}
            className={`whitespace-nowrap border-b-2 px-3 py-2 text-sm ${
              active ? "border-slate-900 font-semibold text-slate-900" : "border-transparent text-slate-600 hover:text-slate-900"
            }`}
          >
            {t(tab.key)}
          </Link>
        );
      })}
    </nav>
  );
}
