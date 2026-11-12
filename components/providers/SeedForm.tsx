"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { useT } from "@/lib/i18n/client";
import { COUNCILS, PROFILE_LANGUAGES, PROVIDER_TYPES } from "@/lib/providers/constants";
import { buttonClass, fieldKeys, inputClass, labelClass, send } from "./request";

// FR-5 admin seeding form: organisation + location + unclaimed profile from public information.
export function SeedForm() {
  const t = useT("providers");
  const td = useT("directory.editor");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState(false);
  const [invalid, setInvalid] = useState<string[]>([]);
  const [verified, setVerified] = useState(false);
  const [council, setCouncil] = useState("");

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formEl = event.currentTarget;
    const form = new FormData(formEl);
    const v = (k: string) => String(form.get(k) ?? "").trim();
    const years = v("years_experience");
    setBusy(true);
    setError("");
    setCreated(false);
    setInvalid([]);
    const res = await send("/api/admin/providers", "POST", {
      org_name: v("org_name"),
      org_kind: v("org_kind"),
      phone_public: v("phone_public"),
      website: v("website"),
      location: {
        name: v("loc_name"),
        address_line1: v("address_line1"),
        address_line2: v("address_line2"),
        locality: v("locality"),
        city: v("city"),
        state: v("state"),
        pincode: v("pincode"),
      },
      display_name: v("display_name"),
      provider_type: v("provider_type"),
      qualifications: v("qualifications"),
      bio: v("bio"),
      languages: form.getAll("languages").map(String),
      years_experience: years === "" ? null : Number(years),
      registration_council: council || null,
      registration_state: v("registration_state"),
      registration_number: v("registration_number"),
      verified,
      verification_note: v("verification_note"),
      is_synthetic: form.get("is_synthetic") === "on",
      offers_in_clinic: form.get("offers_in_clinic") === "on",
      offers_video: form.get("offers_video") === "on",
    });
    setBusy(false);
    if (!res.ok) {
      setInvalid(fieldKeys(res.json));
      return setError(res.status === 400 ? t("form.invalid") : t("form.failed"));
    }
    formEl.reset();
    setVerified(false);
    setCouncil("");
    setCreated(true);
  }

  const bad = (k: string) => invalid.includes(k);
  const text = (name: string, label: string, opts: { required?: boolean; max?: number; defaultValue?: string; error?: string } = {}) => (
    <div>
      <label htmlFor={`seed-${name}`} className={labelClass}>
        {label} {opts.required ? null : <span className="font-normal text-slate-500">{t("form.optional")}</span>}
      </label>
      <input
        id={`seed-${name}`}
        name={name}
        required={opts.required}
        maxLength={opts.max ?? 200}
        defaultValue={opts.defaultValue}
        aria-invalid={bad(opts.error ?? name)}
        className={inputClass}
      />
    </div>
  );

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      <fieldset className="grid gap-3 rounded border border-slate-200 bg-white p-4 sm:grid-cols-2">
        <legend className="px-1 text-base font-semibold">{t("adminSeed.orgSection")}</legend>
        {text("org_name", t("adminSeed.orgName"), { required: true, max: 120 })}
        <div>
          <label htmlFor="seed-org_kind" className={labelClass}>
            {t("adminSeed.orgKind")}
          </label>
          <select id="seed-org_kind" name="org_kind" defaultValue="centre" className={inputClass}>
            <option value="centre">{t("adminSeed.centre")}</option>
            <option value="solo">{t("adminSeed.solo")}</option>
          </select>
        </div>
        {text("phone_public", t("adminSeed.phone"), { max: 20 })}
        {text("website", t("adminSeed.website"))}
      </fieldset>

      <fieldset className="grid gap-3 rounded border border-slate-200 bg-white p-4 sm:grid-cols-2">
        <legend className="px-1 text-base font-semibold">{t("adminSeed.locationSection")}</legend>
        {text("loc_name", t("locations.name"), { required: true, max: 120, error: "location" })}
        {text("address_line1", t("locations.address1"), { required: true, error: "location" })}
        {text("address_line2", t("locations.address2"))}
        {text("locality", t("locations.locality"), { required: true, max: 80, error: "location" })}
        {text("city", t("locations.city"), { required: true, max: 80, defaultValue: "Hyderabad" })}
        {text("state", t("locations.state"), { required: true, max: 80, defaultValue: "Telangana" })}
        <div>
          <label htmlFor="seed-pincode" className={labelClass}>
            {t("locations.pincode")}
          </label>
          <input id="seed-pincode" name="pincode" required inputMode="numeric" pattern="[1-9][0-9]{5}" maxLength={6} aria-invalid={bad("location")} className={inputClass} />
        </div>
      </fieldset>

      <fieldset className="grid gap-3 rounded border border-slate-200 bg-white p-4 sm:grid-cols-2">
        <legend className="px-1 text-base font-semibold">{t("adminSeed.providerSection")}</legend>
        {text("display_name", t("adminSeed.providerName"), { required: true, max: 120 })}
        <div>
          <label htmlFor="seed-type" className={labelClass}>
            {t("editor.type")}
          </label>
          <select id="seed-type" name="provider_type" required defaultValue="" aria-invalid={bad("provider_type")} className={inputClass}>
            <option value="" disabled>
              {t("form.choose")}
            </option>
            {PROVIDER_TYPES.map((type) => (
              <option key={type} value={type}>
                {t(`types.${type}`)}
              </option>
            ))}
          </select>
        </div>
        {text("qualifications", t("editor.qualifications"), { max: 300 })}
        <div>
          <label htmlFor="seed-years" className={labelClass}>
            {t("editor.experience")} <span className="font-normal text-slate-500">{t("form.optional")}</span>
          </label>
          <input id="seed-years" name="years_experience" type="number" min={0} max={60} inputMode="numeric" className={inputClass} />
        </div>
        <div className="sm:col-span-2">
          <label htmlFor="seed-bio" className={labelClass}>
            {t("editor.bio")} <span className="font-normal text-slate-500">{t("form.optional")}</span>
          </label>
          <textarea id="seed-bio" name="bio" rows={3} maxLength={1500} className={inputClass} />
        </div>
        <fieldset className="sm:col-span-2">
          <legend className={labelClass}>{t("editor.languages")}</legend>
          <div className="mt-1 flex flex-wrap gap-x-4">
            {PROFILE_LANGUAGES.map((lang) => (
              <label key={lang} className="flex min-h-11 items-center gap-2 text-sm">
                <input type="checkbox" name="languages" value={lang} className="h-4 w-4" />
                {t(`languages.${lang}`)}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="flex min-h-11 items-center gap-2 text-sm sm:col-span-2">
          <input type="checkbox" name="is_synthetic" className="h-4 w-4" />
          {t("adminSeed.synthetic")}
        </label>
        <fieldset className="sm:col-span-2">
          <legend className={labelClass}>{td("modes")}</legend>
          <div className="flex flex-wrap gap-x-4">
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input type="checkbox" name="offers_in_clinic" defaultChecked className="h-4 w-4" />
              {td("offersInClinic")}
            </label>
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input type="checkbox" name="offers_video" className="h-4 w-4" />
              {td("offersVideo")}
            </label>
          </div>
        </fieldset>
      </fieldset>

      <fieldset className="grid gap-3 rounded border border-slate-200 bg-white p-4 sm:grid-cols-2">
        <legend className="px-1 text-base font-semibold">{t("adminSeed.registrationSection")}</legend>
        <div>
          <label htmlFor="seed-council" className={labelClass}>
            {t("verification.council")} <span className="font-normal text-slate-500">{t("form.optional")}</span>
          </label>
          <select id="seed-council" value={council} onChange={(e) => setCouncil(e.target.value)} className={inputClass}>
            <option value="">{t("form.choose")}</option>
            {COUNCILS.map((c) => (
              <option key={c} value={c}>
                {t(`councils.${c}`)}
              </option>
            ))}
          </select>
        </div>
        {council === "STATE_MEDICAL_COUNCIL" ? text("registration_state", t("verification.state"), { required: true, max: 60, defaultValue: "Telangana" }) : null}
        {text("registration_number", t("verification.number"), { required: verified, max: 60 })}
        <label className="flex min-h-11 items-center gap-2 text-sm sm:col-span-2">
          <input type="checkbox" checked={verified} onChange={(e) => setVerified(e.target.checked)} className="h-4 w-4" />
          {t("adminSeed.verified")}
        </label>
        {verified ? (
          <div className="sm:col-span-2">
            <label htmlFor="seed-note" className={labelClass}>
              {t("adminSeed.verifiedNote")}
            </label>
            <textarea id="seed-note" name="verification_note" rows={2} maxLength={1000} required={council === "OTHER"} aria-invalid={bad("verification_note")} className={inputClass} />
          </div>
        ) : null}
      </fieldset>

      {error ? (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      ) : null}
      {created ? (
        <p role="status" className="text-sm text-teal-800">
          {t("adminSeed.created")}{" "}
          <Link href="/admin/providers" className="font-medium underline">
            {t("adminSeed.backToList")}
          </Link>
        </p>
      ) : null}
      <button type="submit" disabled={busy} className={buttonClass}>
        {busy ? t("adminSeed.submitting") : t("adminSeed.submit")}
      </button>
    </form>
  );
}
