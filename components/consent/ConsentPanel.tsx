import Link from "next/link";
import { ClaimCodeButton } from "@/components/consent/ClaimCodeButton";
import { countActiveGuardians } from "@/lib/children";
import { CONSENT_FEATURES, getConsentState, type ConsentStatus } from "@/lib/consent";
import { supabaseAdmin } from "@/lib/db";
import { getFormatter, getT } from "@/lib/i18n/server";
import type { CaseRow } from "@/lib/types";

async function providerNames(ids: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (ids.length === 0) return names;
  const db = supabaseAdmin();
  const { data } = await db.from("user_profiles").select("id, display_name").in("id", ids);
  for (const row of (data ?? []) as { id: string; display_name: string | null }[]) {
    if (row.display_name) names.set(row.id, row.display_name);
  }
  for (const id of ids.filter((i) => !names.has(i))) {
    const { data: user } = await db.auth.admin.getUserById(id);
    if (user?.user?.email) names.set(id, user.user.email);
  }
  return names;
}

const linkClass = "inline-flex min-h-11 items-center rounded border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-900";

// 020 FR-14 / FR-18d: read-only consent panel in the case workspace. Paper consents recorded through another
// organisation's case show "another centre" (no cross-org detail, rule 2).
export async function ConsentPanel({ caseRow }: { caseRow: CaseRow & { child_id: string } }) {
  const t = await getT("consentPanel");
  const tc = await getT("consent");
  const format = await getFormatter();
  const [state, guardians] = await Promise.all([getConsentState(caseRow.child_id), countActiveGuardians(caseRow.child_id)]);
  const ownAttesters = CONSENT_FEATURES.map((f) => state[f])
    .filter((s) => s.method === "paper" && s.case_id === caseRow.id && s.attested_by)
    .map((s) => s.attested_by as string);
  const names = await providerNames([...new Set(ownAttesters)]);

  const detail = (s: ConsentStatus): string => {
    if (!s.action || !s.at) return t("never");
    const date = format.date(s.at, "long");
    if (s.action === "withdrawn") return t("withdrawnOn", { date });
    if (s.method === "paper") {
      const provider = s.case_id === caseRow.id && s.attested_by ? (names.get(s.attested_by) ?? t("anotherCentre")) : t("anotherCentre");
      return t("paperOn", { provider, date });
    }
    return t("digitalOn", { date });
  };

  return (
    <section aria-labelledby="consent-heading" className="space-y-4 rounded border border-slate-200 p-4" data-testid="consent-panel">
      <h2 id="consent-heading" className="text-lg font-semibold">
        {t("title")}
      </h2>
      {guardians > 0 ? (
        <p className="text-sm font-medium text-emerald-800">{t("linked")}</p>
      ) : (
        <div className="space-y-2">
          <p className="text-sm text-slate-700">{t("notLinked")}</p>
          <ClaimCodeButton caseId={caseRow.id} />
        </div>
      )}
      <ul className="divide-y divide-slate-100">
        {CONSENT_FEATURES.map((feature) => {
          const s = state[feature];
          return (
            <li key={feature} className="flex flex-col gap-1 py-2 sm:flex-row sm:items-start sm:justify-between" data-feature={feature}>
              <span className="text-sm font-medium text-slate-900">{tc(`features.${feature}.name`)}</span>
              <span className="text-sm text-slate-700 sm:text-right">
                <span className={s.granted ? "font-semibold text-emerald-800" : "font-semibold text-slate-600"}>
                  {s.granted ? tc("allowed") : tc("notAllowed")}
                </span>
                <span className="block">{detail(s)}</span>
                {s.method === "paper" && s.action === "granted" && s.case_id === caseRow.id && s.record_id ? (
                  <a href={`/api/cases/${caseRow.id}/paper-consents/${s.record_id}/scan`} className="block underline" target="_blank" rel="noreferrer">
                    {t("viewScan")}
                  </a>
                ) : null}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="text-sm text-slate-600">{t("hint")}</p>
      <div className="flex flex-wrap gap-2 print:hidden">
        <Link href={`/cases/${caseRow.id}/consent-form?locale=${caseRow.language}`} className={linkClass}>
          {t("printForm")}
        </Link>
        <Link href={`/cases/${caseRow.id}/consent/paper`} className={linkClass}>
          {t("recordPaper")}
        </Link>
        <Link href="/privacy" className={linkClass}>
          {(await getT("privacy"))("link")}
        </Link>
      </div>
    </section>
  );
}
