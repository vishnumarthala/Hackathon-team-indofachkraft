import type { Metadata } from "next";
import { env } from "@/lib/env";
import { getT } from "@/lib/i18n/server";
import { retentionPolicy } from "@/lib/privacy/retention";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT("privacy.notice");
  return { title: `${t("metaTitle")} | DoctorNearMe` };
}

const COLLECT = ["account", "children", "consent", "health", "documents", "intake", "sessions", "scribe", "assessments", "plans", "homeProgram", "appointments", "messages", "notifications", "website"] as const;
const PROCESSORS = ["elevenlabs", "gemini", "resend", "whatsapp", "supabase"] as const;
const RIGHTS = ["access", "correction", "erasure", "withdraw", "grievance", "nominate"] as const;

// 041 FR-10: public privacy notice (en/hi/te). The draft badge stays until a human sets PRIVACY_NOTICE_REVIEWED=true
// after legal review. Retention values come from lib/privacy/retention.ts (the periods actually in effect).
export default async function PrivacyNoticePage() {
  const t = await getT("privacy.notice");
  const policy = retentionPolicy();
  const region = env.SUPABASE_REGION_LABEL ?? "-";
  const grievance = env.GRIEVANCE_OFFICER_EMAIL;
  const retention: { key: string; what: string; how: string }[] = [
    { key: "audio", what: t("retention.audio.what"), how: t("retention.audio.how", { days: policy.audioDays }) },
    { key: "pending", what: t("retention.pending.what"), how: t("retention.pending.how") },
    { key: "inApp", what: t("retention.inApp.what"), how: t("retention.inApp.how", { days: policy.inAppNotificationDays }) },
    { key: "delivery", what: t("retention.delivery.what"), how: t("retention.delivery.how", { days: policy.deliveryContentDays }) },
    { key: "exports", what: t("retention.exports.what"), how: t("retention.exports.how", { days: policy.exportDays }) },
    { key: "signups", what: t("retention.signups.what"), how: t("retention.signups.how", { months: policy.pilotSignupMonths }) },
    { key: "clinical", what: t("retention.clinical.what"), how: t("retention.clinical.how") },
    { key: "appointments", what: t("retention.appointments.what"), how: t("retention.appointments.how") },
    { key: "messages", what: t("retention.messages.what"), how: t("retention.messages.how") },
    { key: "consent", what: t("retention.consent.what"), how: t("retention.consent.how") },
    { key: "audit", what: t("retention.audit.what"), how: t("retention.audit.how", { years: policy.auditYears }) },
  ];
  const section = "space-y-3";
  const h2 = "text-xl font-semibold text-slate-900";

  return (
    <article className="mx-auto w-full max-w-3xl space-y-8 px-4 py-8 text-slate-800">
      <header className="space-y-3">
        {!env.PRIVACY_NOTICE_REVIEWED ? (
          <p
            role="note"
            data-testid="privacy-draft-badge"
            className="inline-block rounded-full bg-amber-100 px-3 py-1 text-sm font-semibold text-amber-900"
          >
            {t("draftBadge")}
          </p>
        ) : null}
        <h1 className="text-3xl font-bold text-slate-900">{t("title")}</h1>
        <p>{t("intro")}</p>
      </header>

      <section aria-labelledby="controller" className={section}>
        <h2 id="controller" className={h2}>{t("controllerTitle")}</h2>
        <p>{t("controller")}</p>
      </section>

      <section aria-labelledby="collect" className={section}>
        <h2 id="collect" className={h2}>{t("collectTitle")}</h2>
        <ul className="list-disc space-y-2 pl-5">
          {COLLECT.map((k) => (
            <li key={k}>{t(`collect.${k}`)}</li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="purposes" className={section}>
        <h2 id="purposes" className={h2}>{t("purposesTitle")}</h2>
        <p>{t("purposes")}</p>
      </section>

      <section aria-labelledby="processors" className={section}>
        <h2 id="processors" className={h2}>{t("processorsTitle")}</h2>
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="min-w-full text-left text-sm" data-testid="privacy-processors">
            <thead className="bg-slate-50 text-slate-700">
              <tr>
                <th scope="col" className="px-3 py-2">{t("processorName")}</th>
                <th scope="col" className="px-3 py-2">{t("processorPurpose")}</th>
                <th scope="col" className="px-3 py-2">{t("processorLocation")}</th>
              </tr>
            </thead>
            <tbody>
              {PROCESSORS.map((p) => (
                <tr key={p} className="border-t border-slate-200 align-top">
                  <th scope="row" className="px-3 py-2 font-medium">{t(`processors.${p}.name`)}</th>
                  <td className="px-3 py-2">{t(`processors.${p}.purpose`)}</td>
                  <td className="px-3 py-2">{t(`processors.${p}.location`, { region })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>{t("crossBorder")}</p>
      </section>

      <section aria-labelledby="retention" className={section}>
        <h2 id="retention" className={h2}>{t("retentionTitle")}</h2>
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="min-w-full text-left text-sm" data-testid="privacy-retention">
            <thead className="bg-slate-50 text-slate-700">
              <tr>
                <th scope="col" className="px-3 py-2">{t("retentionWhat")}</th>
                <th scope="col" className="px-3 py-2">{t("retentionHow")}</th>
              </tr>
            </thead>
            <tbody>
              {retention.map((r) => (
                <tr key={r.key} className="border-t border-slate-200 align-top">
                  <th scope="row" className="px-3 py-2 font-medium">{r.what}</th>
                  <td className="px-3 py-2">{r.how}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="rights" className={section}>
        <h2 id="rights" className={h2}>{t("rightsTitle")}</h2>
        <ul className="list-disc space-y-2 pl-5">
          {RIGHTS.map((k) => (
            <li key={k}>{t(`rights.${k}`)}</li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="children" className={section}>
        <h2 id="children" className={h2}>{t("childrenTitle")}</h2>
        <p>{t("children")}</p>
      </section>

      <section aria-labelledby="contact" className={section}>
        <h2 id="contact" className={h2}>{t("contactTitle")}</h2>
        <p data-testid="grievance-officer">
          {grievance ? t("contact", { email: grievance }) : t("contactMissing")}
        </p>
        <p className="text-sm text-slate-600">{t("updated")}</p>
      </section>
    </article>
  );
}
