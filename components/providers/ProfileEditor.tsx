"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { useT } from "@/lib/i18n/client";
import {
  CERTIFICATE_MIME_TYPES,
  COUNCILS,
  MAX_CERTIFICATE_BYTES,
  MAX_PHOTO_BYTES,
  PROFILE_LANGUAGES,
  PROVIDER_TYPES,
  type Council,
} from "@/lib/providers/constants";
import { supabaseBrowser } from "@/lib/supabase-browser";
import { buttonClass, fieldKeys, inputClass, labelClass, secondaryButtonClass, send } from "./request";

type Status = "unverified" | "pending" | "verified" | "rejected" | "suspended";

function useSaver() {
  const t = useT("providers");
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [invalid, setInvalid] = useState<string[]>([]);

  async function run(url: string, method: string, body: unknown, errorFor?: (status: number) => string | null) {
    setBusy(true);
    setError("");
    setSaved(false);
    setInvalid([]);
    const res = await send(url, method, body);
    setBusy(false);
    if (res.ok) {
      setSaved(true);
      router.refresh();
      return res;
    }
    setInvalid(fieldKeys(res.json));
    setError(errorFor?.(res.status) ?? (res.status === 400 ? t("form.invalid") : t("form.failed")));
    return res;
  }

  return { busy, setBusy, error, setError, saved, setSaved, invalid, run };
}

function Feedback({ error, saved }: { error: string; saved: boolean }) {
  const t = useT("providers");
  if (error) {
    return (
      <p role="alert" className="text-sm text-red-700">
        {error}
      </p>
    );
  }
  return saved ? (
    <p role="status" className="text-sm text-teal-800">
      {t("form.saved")}
    </p>
  ) : null;
}

export function ListingToggle({ profileId, listed, status }: { profileId: string; listed: boolean; status: Status }) {
  const t = useT("providers");
  const { busy, error, run } = useSaver();
  const verified = status === "verified";
  return (
    <div className="space-y-1">
      <label className="flex min-h-11 items-center gap-3 text-sm font-medium text-slate-900">
        <input
          type="checkbox"
          className="h-5 w-5"
          checked={listed}
          disabled={!verified || busy}
          aria-describedby="listing-hint"
          onChange={(e) => run(`/api/providers/${profileId}/listing`, "PATCH", { listed: e.target.checked })}
        />
        {t("listing.label")}
      </label>
      <p id="listing-hint" className="text-sm text-slate-600">
        {verified ? (listed ? t("listing.on") : t("listing.off")) : t("listing.disabledHint")}
      </p>
      <Feedback error={error} saved={false} />
    </div>
  );
}

export type EditableProfile = {
  id: string;
  display_name: string;
  provider_type: string;
  qualifications: string | null;
  bio: string | null;
  languages: string[];
  years_experience: number | null;
  time_zone: string;
  offers_in_clinic: boolean;
  offers_video: boolean;
};

export function ProfileForm({ profile, verified }: { profile: EditableProfile; verified: boolean }) {
  const t = useT("providers");
  const td = useT("directory.editor");
  const { busy, error, saved, invalid, run } = useSaver();
  const [languages, setLanguages] = useState<string[]>(profile.languages);
  const [type, setType] = useState(profile.provider_type);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const years = String(form.get("years_experience") ?? "").trim();
    await run(`/api/providers/${profile.id}`, "PATCH", {
      display_name: String(form.get("display_name") ?? ""),
      provider_type: type,
      qualifications: String(form.get("qualifications") ?? ""),
      bio: String(form.get("bio") ?? ""),
      languages,
      years_experience: years === "" ? null : Number(years),
      time_zone: String(form.get("time_zone") ?? ""),
      offers_in_clinic: form.get("offers_in_clinic") === "on",
      offers_video: form.get("offers_video") === "on",
    });
  }

  const bad = (key: string) => invalid.includes(key);
  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div>
        <label htmlFor="pf-name" className={labelClass}>
          {t("editor.displayName")}
        </label>
        <input id="pf-name" name="display_name" required maxLength={120} defaultValue={profile.display_name} aria-invalid={bad("display_name")} className={inputClass} />
      </div>
      <div>
        <label htmlFor="pf-type" className={labelClass}>
          {t("editor.type")}
        </label>
        <select id="pf-type" value={type} onChange={(e) => setType(e.target.value)} aria-invalid={bad("provider_type")} className={inputClass} aria-describedby={verified ? "pf-type-warning" : undefined}>
          {PROVIDER_TYPES.map((value) => (
            <option key={value} value={value}>
              {t(`types.${value}`)}
            </option>
          ))}
        </select>
        {verified ? (
          <p id="pf-type-warning" className="mt-1 text-xs text-amber-800">
            {t("editor.typeWarning")}
          </p>
        ) : null}
      </div>
      <div>
        <label htmlFor="pf-qual" className={labelClass}>
          {t("editor.qualifications")} <span className="font-normal text-slate-500">{t("form.optional")}</span>
        </label>
        <input id="pf-qual" name="qualifications" maxLength={300} defaultValue={profile.qualifications ?? ""} placeholder={t("editor.qualificationsHint")} aria-invalid={bad("qualifications")} className={inputClass} />
      </div>
      <div>
        <label htmlFor="pf-bio" className={labelClass}>
          {t("editor.bio")} <span className="font-normal text-slate-500">{t("form.optional")}</span>
        </label>
        <textarea id="pf-bio" name="bio" rows={5} maxLength={1500} defaultValue={profile.bio ?? ""} aria-invalid={bad("bio")} className={inputClass} />
      </div>
      <fieldset>
        <legend className={labelClass}>{t("editor.languages")}</legend>
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
          {PROFILE_LANGUAGES.map((lang) => (
            <label key={lang} className="flex min-h-11 items-center gap-2 text-sm text-slate-800">
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={languages.includes(lang)}
                onChange={(e) => setLanguages((prev) => (e.target.checked ? [...prev, lang] : prev.filter((l) => l !== lang)))}
              />
              {t(`languages.${lang}`)}
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset aria-describedby="pf-modes-hint">
        <legend className={labelClass}>{td("modes")}</legend>
        <p id="pf-modes-hint" className="text-xs text-slate-600">
          {td("modesHint")}
        </p>
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
          <label className="flex min-h-11 items-center gap-2 text-sm text-slate-800">
            <input type="checkbox" name="offers_in_clinic" className="h-4 w-4" defaultChecked={profile.offers_in_clinic} />
            {td("offersInClinic")}
          </label>
          <label className="flex min-h-11 items-center gap-2 text-sm text-slate-800">
            <input type="checkbox" name="offers_video" className="h-4 w-4" defaultChecked={profile.offers_video} />
            {td("offersVideo")}
          </label>
        </div>
      </fieldset>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="pf-years" className={labelClass}>
            {t("editor.experience")}
          </label>
          <input id="pf-years" name="years_experience" type="number" min={0} max={60} step={1} inputMode="numeric" defaultValue={profile.years_experience ?? ""} aria-invalid={bad("years_experience")} className={inputClass} />
        </div>
        <div>
          <label htmlFor="pf-tz" className={labelClass}>
            {t("editor.timeZone")}
          </label>
          <input id="pf-tz" name="time_zone" required maxLength={64} defaultValue={profile.time_zone} aria-invalid={bad("time_zone")} className={inputClass} />
        </div>
      </div>
      <Feedback error={error} saved={saved} />
      <button type="submit" disabled={busy} className={buttonClass}>
        {busy ? t("form.saving") : t("editor.save")}
      </button>
    </form>
  );
}

export function PhotoForm({ profileId, photoUrl, name }: { profileId: string; photoUrl: string | null; name: string }) {
  const t = useT("providers");
  const { busy, setBusy, error, setError, run } = useSaver();
  const router = useRouter();

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const file = new FormData(event.currentTarget).get("file");
    if (!(file instanceof File) || file.size === 0) return;
    if (file.size > MAX_PHOTO_BYTES) return setError(t("photo.tooLarge"));
    if (!["image/jpeg", "image/png"].includes(file.type)) return setError(t("photo.wrongType"));
    setBusy(true);
    setError("");
    const body = new FormData();
    body.set("file", file);
    const res = await fetch(`/api/providers/${profileId}/photo`, { method: "POST", body }).catch(() => null);
    setBusy(false);
    if (!res?.ok) return setError(res?.status === 400 ? t("photo.wrongType") : t("form.failed"));
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
      {photoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- user-uploaded image from Supabase storage
        <img src={photoUrl} alt={t("photo.alt", { name })} width={96} height={96} className="h-24 w-24 rounded-full object-cover" />
      ) : (
        <div aria-hidden="true" className="flex h-24 w-24 items-center justify-center rounded-full bg-slate-200 text-2xl font-semibold text-slate-600">
          {name.slice(0, 1).toUpperCase()}
        </div>
      )}
      <form onSubmit={onSubmit} className="space-y-2">
        <label htmlFor="photo-file" className={labelClass}>
          {t("photo.choose")}
        </label>
        <input id="photo-file" name="file" type="file" accept="image/jpeg,image/png" required aria-describedby="photo-hint" className="block text-sm" />
        <p id="photo-hint" className="text-xs text-slate-600">
          {t("photo.hint")}
        </p>
        <Feedback error={error} saved={false} />
        <div className="flex flex-wrap gap-2">
          <button type="submit" disabled={busy} className={buttonClass}>
            {busy ? t("photo.uploading") : t("photo.upload")}
          </button>
          {photoUrl ? (
            <button type="button" disabled={busy} onClick={() => run(`/api/providers/${profileId}/photo`, "DELETE", undefined)} className={secondaryButtonClass}>
              {t("photo.remove")}
            </button>
          ) : null}
        </div>
      </form>
    </div>
  );
}

type LocationView = { id: string; name: string; address_line1: string; locality: string; city: string; pincode: string; orgName: string; mapped: boolean };
type OrgView = { id: string; name: string; canManage: boolean; locations: LocationView[] };

function Address({ loc }: { loc: LocationView }) {
  const td = useT("directory.editor");
  return (
    <span>
      <span className="font-medium text-slate-900">{loc.name}</span> ({loc.orgName}) - {loc.address_line1}, {loc.locality}, {loc.city} {loc.pincode}
      {/* 029 FR-4: a location without coordinates is not searchable. */}
      {loc.mapped ? null : <span className="block text-xs text-amber-800">{td("notOnMap")}</span>}
    </span>
  );
}

export function LocationsPanel({ profileId, linked, orgs }: { profileId: string; linked: LocationView[]; orgs: OrgView[] }) {
  const t = useT("providers");
  const td = useT("directory.editor");
  const { busy, error, invalid, run } = useSaver();
  const [unmapped, setUnmapped] = useState(false);
  const linkedIds = new Set(linked.map((l) => l.id));
  const available = orgs.flatMap((o) => o.locations).filter((l) => !linkedIds.has(l.id));
  const managed = orgs.filter((o) => o.canManage);

  async function onCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formEl = event.currentTarget;
    const form = new FormData(formEl);
    const value = (k: string) => String(form.get(k) ?? "");
    const res = await run(`/api/providers/${profileId}/locations`, "POST", {
      org_id: value("org_id"),
      name: value("name"),
      address_line1: value("address_line1"),
      address_line2: value("address_line2"),
      locality: value("locality"),
      city: value("city"),
      state: value("state"),
      pincode: value("pincode"),
    });
    setUnmapped(res.ok && res.json.geocoded === false);
    if (res.ok) formEl.reset();
  }

  const bad = (key: string) => invalid.includes(key);
  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-sm font-semibold text-slate-900">{t("locations.linked")}</h3>
        {linked.length === 0 ? (
          <p className="text-sm text-slate-600">{t("locations.none")}</p>
        ) : (
          <ul className="mt-1 space-y-2">
            {linked.map((loc) => (
              <li key={loc.id} className="flex flex-wrap items-center justify-between gap-2 text-sm text-slate-700">
                <Address loc={loc} />
                <button type="button" disabled={busy} onClick={() => run(`/api/providers/${profileId}/locations/${loc.id}`, "DELETE", undefined)} className="min-h-11 text-sm font-medium text-red-700 underline">
                  {t("locations.remove")}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {available.length > 0 ? (
        <div>
          <h3 className="text-sm font-semibold text-slate-900">{t("locations.available")}</h3>
          <ul className="mt-1 space-y-2">
            {available.map((loc) => (
              <li key={loc.id} className="flex flex-wrap items-center justify-between gap-2 text-sm text-slate-700">
                <Address loc={loc} />
                <button type="button" disabled={busy} onClick={() => run(`/api/providers/${profileId}/locations`, "POST", { location_id: loc.id })} className={secondaryButtonClass}>
                  {t("locations.add")}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {orgs.length === 0 ? (
        <p className="text-sm text-slate-600">{t("locations.noOrgs")}</p>
      ) : managed.length === 0 ? (
        <p className="text-sm text-slate-600">{t("locations.managersOnly")}</p>
      ) : (
        <form onSubmit={onCreate} className="space-y-3 rounded border border-slate-200 p-3">
          <h3 className="text-sm font-semibold text-slate-900">{t("locations.newTitle")}</h3>
          <div>
            <label htmlFor="loc-org" className={labelClass}>
              {t("locations.org")}
            </label>
            <select id="loc-org" name="org_id" className={inputClass}>
              {managed.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {(
              [
                ["name", "locations.name", 120, true],
                ["address_line1", "locations.address1", 200, true],
                ["address_line2", "locations.address2", 200, false],
                ["locality", "locations.locality", 80, true],
                ["city", "locations.city", 80, true],
                ["state", "locations.state", 80, true],
              ] as const
            ).map(([key, label, max, required]) => (
              <div key={key}>
                <label htmlFor={`loc-${key}`} className={labelClass}>
                  {t(label)} {required ? null : <span className="font-normal text-slate-500">{t("form.optional")}</span>}
                </label>
                <input
                  id={`loc-${key}`}
                  name={key}
                  required={required}
                  maxLength={max}
                  defaultValue={key === "city" ? "Hyderabad" : key === "state" ? "Telangana" : undefined}
                  aria-invalid={bad(key)}
                  className={inputClass}
                />
              </div>
            ))}
            <div>
              <label htmlFor="loc-pincode" className={labelClass}>
                {t("locations.pincode")}
              </label>
              <input id="loc-pincode" name="pincode" required inputMode="numeric" pattern="[1-9][0-9]{5}" maxLength={6} aria-invalid={bad("pincode")} className={inputClass} />
            </div>
          </div>
          <button type="submit" disabled={busy} className={buttonClass}>
            {t("locations.create")}
          </button>
        </form>
      )}
      {unmapped ? (
        <p role="alert" className="text-sm text-amber-800">
          {td("geocodeFailed")}
        </p>
      ) : null}
      <Feedback error={error} saved={false} />
    </div>
  );
}

const EXT_OK = CERTIFICATE_MIME_TYPES as readonly string[];

export function VerificationForm({ profileId, status, hasRegistration }: { profileId: string; status: Status; hasRegistration: boolean }) {
  const t = useT("providers");
  const router = useRouter();
  const [council, setCouncil] = useState<Council | "">("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [invalid, setInvalid] = useState<string[]>([]);

  if (status === "suspended") return null;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formEl = event.currentTarget;
    const form = new FormData(formEl);
    const file = form.get("certificate");
    setError("");
    setDone(false);
    setInvalid([]);
    if (!(file instanceof File) || file.size === 0) return;
    if (file.size > MAX_CERTIFICATE_BYTES) return setError(t("verification.tooLarge"));
    if (!EXT_OK.includes(file.type)) return setError(t("verification.wrongType"));
    setBusy(true);

    const upload = await send(`/api/providers/${profileId}/credentials/upload-url`, "POST", {
      file_name: file.name,
      mime_type: file.type,
      size_bytes: file.size,
    });
    if (!upload.ok) {
      setBusy(false);
      return setError(t("verification.uploadFailed"));
    }
    const path = String(upload.json.path);
    const { error: storageError } = await supabaseBrowser()
      .storage.from("credentials")
      .uploadToSignedUrl(path, String(upload.json.token), file, { contentType: file.type });
    if (storageError) {
      setBusy(false);
      return setError(t("verification.uploadFailed"));
    }

    const res = await send(`/api/providers/${profileId}/credentials`, "POST", {
      council,
      state: String(form.get("state") ?? ""),
      registration_number: String(form.get("registration_number") ?? ""),
      certificate_path: path,
    });
    setBusy(false);
    if (!res.ok) {
      setInvalid(fieldKeys(res.json));
      return setError(res.status === 400 ? t("form.invalid") : t("form.failed"));
    }
    formEl.reset();
    setCouncil("");
    setDone(true);
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <p className="text-sm text-slate-700">{t("verification.otherHint")}</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="vf-council" className={labelClass}>
            {t("verification.council")}
          </label>
          <select id="vf-council" required value={council} onChange={(e) => setCouncil(e.target.value as Council)} aria-invalid={invalid.includes("council")} className={inputClass}>
            <option value="" disabled>
              {t("form.choose")}
            </option>
            {COUNCILS.map((c) => (
              <option key={c} value={c}>
                {t(`councils.${c}`)}
              </option>
            ))}
          </select>
        </div>
        {council === "STATE_MEDICAL_COUNCIL" ? (
          <div>
            <label htmlFor="vf-state" className={labelClass}>
              {t("verification.state")}
            </label>
            <input id="vf-state" name="state" required maxLength={60} defaultValue="Telangana" aria-invalid={invalid.includes("state")} className={inputClass} />
          </div>
        ) : null}
        <div>
          <label htmlFor="vf-number" className={labelClass}>
            {t("verification.number")}
          </label>
          <input id="vf-number" name="registration_number" required maxLength={60} autoComplete="off" aria-invalid={invalid.includes("registration_number")} className={inputClass} />
        </div>
      </div>
      <div>
        <label htmlFor="vf-file" className={labelClass}>
          {t("verification.certificate")}
        </label>
        <input id="vf-file" name="certificate" type="file" required accept="application/pdf,image/jpeg,image/png" aria-invalid={invalid.includes("certificate_path")} className="mt-1 block text-sm" />
      </div>
      {status === "verified" || (status === "pending" && hasRegistration) ? (
        <p className="text-xs text-amber-800">{t("verification.reverifyWarning")}</p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      ) : null}
      {done ? (
        <p role="status" className="text-sm text-teal-800">
          {t("verification.submitted")}
        </p>
      ) : null}
      <button type="submit" disabled={busy} className={buttonClass}>
        {busy ? t("verification.submitting") : t("verification.submit")}
      </button>
    </form>
  );
}

export type OrgPublicView = {
  id: string;
  name: string;
  public_name: string | null;
  about: string | null;
  phone_public: string | null;
  website: string | null;
  listed: boolean;
};

export function OrgPublicForm({ org }: { org: OrgPublicView }) {
  const t = useT("providers");
  const { busy, error, saved, invalid, run } = useSaver();

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await run(
      `/api/orgs/${org.id}/public`,
      "PATCH",
      {
        public_name: String(form.get("public_name") ?? ""),
        about: String(form.get("about") ?? ""),
        phone_public: String(form.get("phone_public") ?? ""),
        website: String(form.get("website") ?? ""),
        listed: form.get("listed") === "on",
      },
      (status) => (status === 409 ? t("org.listedHint") : null),
    );
  }

  const bad = (key: string) => invalid.includes(key);
  const id = (key: string) => `org-${org.id}-${key}`;
  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <h3 className="text-base font-semibold text-slate-900">{t("org.title", { name: org.name })}</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={id("name")} className={labelClass}>
            {t("org.publicName")}
          </label>
          <input id={id("name")} name="public_name" maxLength={120} defaultValue={org.public_name ?? org.name} aria-invalid={bad("public_name")} className={inputClass} />
        </div>
        <div>
          <label htmlFor={id("phone")} className={labelClass}>
            {t("org.phone")} <span className="font-normal text-slate-500">{t("form.optional")}</span>
          </label>
          <input id={id("phone")} name="phone_public" type="tel" maxLength={20} defaultValue={org.phone_public ?? ""} aria-invalid={bad("phone_public")} className={inputClass} />
        </div>
        <div className="sm:col-span-2">
          <label htmlFor={id("web")} className={labelClass}>
            {t("org.website")} <span className="font-normal text-slate-500">{t("form.optional")}</span>
          </label>
          <input id={id("web")} name="website" type="url" maxLength={200} defaultValue={org.website ?? ""} aria-invalid={bad("website")} className={inputClass} />
        </div>
        <div className="sm:col-span-2">
          <label htmlFor={id("about")} className={labelClass}>
            {t("org.about")} <span className="font-normal text-slate-500">{t("form.optional")}</span>
          </label>
          <textarea id={id("about")} name="about" rows={3} maxLength={2000} defaultValue={org.about ?? ""} aria-invalid={bad("about")} className={inputClass} />
        </div>
      </div>
      <label className="flex min-h-11 items-center gap-3 text-sm font-medium text-slate-900">
        <input type="checkbox" name="listed" defaultChecked={org.listed} className="h-5 w-5" aria-describedby={id("listed-hint")} />
        {t("org.listed")}
      </label>
      <p id={id("listed-hint")} className="text-xs text-slate-600">
        {t("org.listedHint")}
      </p>
      <Feedback error={error} saved={saved} />
      <button type="submit" disabled={busy} className={buttonClass}>
        {t("org.save")}
      </button>
    </form>
  );
}
