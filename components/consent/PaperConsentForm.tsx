"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { RelationshipSelect } from "@/components/family/children/AddChildForm";
import type { ConsentFeature } from "@/lib/consent/features";
import { LOCALE_LABELS, LOCALES, type Locale } from "@/lib/i18n/config";
import { useT } from "@/lib/i18n/client";
import { Button } from "@/components/ui/Button";

export type PaperFormDocs = Record<Locale, { feature: ConsentFeature; id: string; version: number }[]>;

const field = "mt-1 block min-h-11 w-full rounded border border-slate-300 px-3 py-2 text-sm";

type Status = "idle" | "saving" | "saved" | "invalid" | "outdated" | "failed";

function statusFromResponse(status: number): Status {
  if (status === 400) return "invalid";
  if (status === 409) return "outdated";
  return "failed";
}

// 020 FR-18c: record the paper form the parent signed (ticked features, scan, attestation).
export function PaperConsentForm({
  caseId,
  docs,
  defaultLocale,
  featureNames,
}: {
  caseId: string;
  docs: PaperFormDocs;
  defaultLocale: Locale;
  featureNames: Record<ConsentFeature, string>;
}) {
  const t = useT("paperConsent");
  const tp = useT("privacy");
  const router = useRouter();
  const id = useId();
  const [locale, setLocale] = useState<Locale>(defaultLocale);
  const [features, setFeatures] = useState<ConsentFeature[]>([]);
  const [relationship, setRelationship] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    form.delete("features[]");
    form.delete("consent_document_ids[]");
    for (const f of features) {
      form.append("features[]", f);
      const doc = docs[locale].find((d) => d.feature === f);
      if (doc) form.append("consent_document_ids[]", doc.id);
    }
    form.set("relationship", relationship);
    form.set("attestation", form.get("attestation") === "on" ? "true" : "false");
    setStatus("saving");
    setFieldErrors({});
    try {
      const res = await fetch(`/api/cases/${caseId}/paper-consents`, { method: "POST", body: form });
      if (res.status === 201) {
        setStatus("saved");
        router.refresh();
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { details?: Record<string, string> };
      setFieldErrors(body.details ?? {});
      setStatus(statusFromResponse(res.status));
    } catch {
      setStatus("failed");
    }
  }

  const fieldError = (name: string) =>
    fieldErrors[name] ? (
      <p className="mt-1 text-sm text-red-700" id={`${id}-${name}-error`}>
        {fieldErrors[name]}
      </p>
    ) : null;

  return (
    <form onSubmit={submit} className="space-y-4" noValidate encType="multipart/form-data">
      <div>
        <label htmlFor={`${id}-locale`} className="block text-sm font-medium text-slate-800">
          {t("formLanguage")}
        </label>
        <select id={`${id}-locale`} className={field} value={locale} onChange={(e) => setLocale(e.target.value as Locale)}>
          {LOCALES.map((l) => (
            <option key={l} value={l}>
              {LOCALE_LABELS[l]}
            </option>
          ))}
        </select>
      </div>
      <fieldset>
        <legend className="text-sm font-medium text-slate-800">{t("features")}</legend>
        {docs[locale].map((doc) => (
          <label key={doc.feature} className="flex min-h-11 items-center gap-3 text-sm">
            <input
              type="checkbox"
              checked={features.includes(doc.feature)}
              onChange={(e) =>
                setFeatures((cur) => (e.target.checked ? [...cur, doc.feature] : cur.filter((f) => f !== doc.feature)))
              }
            />
            <span>
              {featureNames[doc.feature]} <span className="text-xs text-slate-500">(v{doc.version} · {doc.id.slice(0, 8)})</span>
            </span>
          </label>
        ))}
        {fieldError("features")}
      </fieldset>
      <div>
        <label htmlFor={`${id}-name`} className="block text-sm font-medium text-slate-800">
          {t("guardianName")}
        </label>
        <input id={`${id}-name`} name="guardian_name" maxLength={100} className={field} />
        {fieldError("guardian_name")}
      </div>
      <RelationshipSelect id={`${id}-rel`} value={relationship} onChange={setRelationship} invalid={Boolean(fieldErrors.relationship)} />
      <div>
        <label htmlFor={`${id}-signed`} className="block text-sm font-medium text-slate-800">
          {t("signedOn")}
        </label>
        <input id={`${id}-signed`} name="signed_on" type="date" className={field} />
        {fieldError("signed_on")}
      </div>
      <div>
        <label htmlFor={`${id}-scan`} className="block text-sm font-medium text-slate-800">
          {t("scan")}
        </label>
        <input id={`${id}-scan`} name="scan" type="file" accept="application/pdf,image/jpeg,image/png" className={field} />
        {fieldError("scan")}
      </div>
      <div className="flex items-start gap-3">
        <input id={`${id}-attest`} name="attestation" type="checkbox" className="mt-1 h-5 w-5 shrink-0" />
        <label htmlFor={`${id}-attest`} className="text-sm text-slate-900">
          {t("attestation")}
        </label>
      </div>
      {fieldError("attestation")}
      <p className="text-sm">
        <Link href="/privacy" className="font-semibold text-teal-800 underline">
          {tp("link")}
        </Link>
      </p>
      <Button type="submit" disabled={status === "saving"}>
        {status === "saving" ? t("saving") : t("submit")}
      </Button>
      {status === "saved" ? (
        <p role="status" className="text-sm font-medium text-emerald-800">
          {t("saved")}
        </p>
      ) : null}
      {status === "invalid" || status === "outdated" || status === "failed" ? (
        <p role="alert" className="text-sm text-red-700">
          {t(status)}
        </p>
      ) : null}
    </form>
  );
}

// 020 FR-18c: the centre records a withdrawal (no scan needed: withdrawing is never harder than granting).
export function PaperWithdrawForm({ caseId, featureNames }: { caseId: string; featureNames: Record<ConsentFeature, string> }) {
  const t = useT("paperConsent");
  const router = useRouter();
  const id = useId();
  const [status, setStatus] = useState<Status>("idle");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setStatus("saving");
    try {
      const res = await fetch(`/api/cases/${caseId}/paper-consents/withdraw`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          feature: form.get("feature"),
          guardian_name: String(form.get("guardian_name") ?? ""),
          note: String(form.get("note") ?? "") || undefined,
        }),
      });
      if (res.ok) {
        setStatus("saved");
        router.refresh();
      } else setStatus(statusFromResponse(res.status));
    } catch {
      setStatus("failed");
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <div>
        <label htmlFor={`${id}-feature`} className="block text-sm font-medium text-slate-800">
          {t("withdrawFeature")}
        </label>
        <select id={`${id}-feature`} name="feature" className={field}>
          {(Object.keys(featureNames) as ConsentFeature[]).map((f) => (
            <option key={f} value={f}>
              {featureNames[f]}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor={`${id}-wname`} className="block text-sm font-medium text-slate-800">
          {t("guardianName")}
        </label>
        <input id={`${id}-wname`} name="guardian_name" maxLength={100} className={field} />
      </div>
      <div>
        <label htmlFor={`${id}-note`} className="block text-sm font-medium text-slate-800">
          {t("note")}
        </label>
        <textarea id={`${id}-note`} name="note" maxLength={500} rows={2} className={field} />
      </div>
      <Button type="submit" disabled={status === "saving"}>
        {status === "saving" ? t("saving") : t("withdrawSubmit")}
      </Button>
      {status === "saved" ? (
        <p role="status" className="text-sm font-medium text-emerald-800">
          {t("saved")}
        </p>
      ) : null}
      {status === "invalid" || status === "outdated" || status === "failed" ? (
        <p role="alert" className="text-sm text-red-700">
          {t(status)}
        </p>
      ) : null}
    </form>
  );
}
