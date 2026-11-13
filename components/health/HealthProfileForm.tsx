"use client";

import { useRouter } from "next/navigation";
import { useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { inputClass, primaryButtonClass, secondaryButtonClass } from "@/components/family/PhoneOtpForm";
import { useT } from "@/lib/i18n/client";
import {
  ALLERGY_SEVERITIES,
  BLOOD_GROUPS,
  hasNoKnownAllergies,
  LIMITS,
  listedAllergies,
  MAX_ENTRIES,
  NO_KNOWN_ALLERGIES,
  sectionsOf,
  type AllergySeverity,
  type BloodGroup,
  type HealthProfile,
  type HealthProfileInput,
  type HealthSection,
} from "@/lib/health/schema";

type AllergyRow = { key: number; substance: string; reaction: string; severity: AllergySeverity };
type MedicationRow = { key: number; name: string; dose: string; frequency: string; since: string };
type ConditionRow = { key: number; name: string; since: string; notes: string };

export type HealthSaveStatus =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "conflict" }
  | { kind: "nka" }
  | { kind: "invalid"; sections: HealthSection[] }
  | { kind: "failed" };

/** Maps a PUT answer to what the editor shows (API errors are English; the UI is translated). */
export function healthSaveStatus(status: number, details?: Record<string, string>): HealthSaveStatus {
  if (status === 409) return { kind: "conflict" };
  if (status === 400 && details) {
    if (Object.entries(details).some(([key, msg]) => key === "allergies" && /no known allergies/i.test(msg))) return { kind: "nka" };
    return { kind: "invalid", sections: sectionsOf(Object.keys(details)) };
  }
  return { kind: "failed" };
}

const MONTH_PATTERN = "(19|20)[0-9]{2}-(0[1-9]|1[0-2])";
const labelClass = "block text-sm font-semibold text-slate-900";

function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className={labelClass}>
        {label}
      </label>
      {children}
    </div>
  );
}

// 021 FR-4: the guardian's editor. Saves the whole profile with the version it started from (D-4).
export function HealthProfileForm({ childId, initial }: { childId: string; initial: HealthProfile }) {
  const t = useT("health");
  const ts = useT("health.sections");
  const tf = useT("health.fields");
  const tsev = useT("health.severity");
  const router = useRouter();
  const id = useId();
  // Initial rows use their index (stable between server render and hydration); new rows count up from MAX_ENTRIES.
  const nextKey = useRef(MAX_ENTRIES);
  const key = () => nextKey.current++;

  const [version, setVersion] = useState(initial.version);
  const [nka, setNka] = useState(hasNoKnownAllergies(initial));
  const [allergies, setAllergies] = useState<AllergyRow[]>(() =>
    listedAllergies(initial).map((a, i) => ({ key: i, substance: a.substance, reaction: a.reaction ?? "", severity: a.severity })),
  );
  const [medications, setMedications] = useState<MedicationRow[]>(() =>
    initial.medications.map((m, i) => ({ key: i, name: m.name, dose: m.dose ?? "", frequency: m.frequency ?? "", since: m.since ?? "" })),
  );
  const [conditions, setConditions] = useState<ConditionRow[]>(() =>
    initial.conditions.map((c, i) => ({ key: i, name: c.name, since: c.since ?? "", notes: c.notes ?? "" })),
  );
  const [birth, setBirth] = useState(initial.birth_history ?? "");
  const [development, setDevelopment] = useState(initial.developmental_history ?? "");
  const [contactName, setContactName] = useState(initial.emergency_contact_name ?? "");
  const [contactPhone, setContactPhone] = useState(initial.emergency_contact_phone ?? "");
  const [bloodGroup, setBloodGroup] = useState<BloodGroup | "">(initial.blood_group ?? "");
  const [status, setStatus] = useState<HealthSaveStatus>({ kind: "idle" });

  function update<R extends { key: number }>(set: (fn: (rows: R[]) => R[]) => void, rowKey: number, patch: Partial<R>) {
    set((rows) => rows.map((r) => (r.key === rowKey ? { ...r, ...patch } : r)));
  }

  function appendRow<R extends { key: number }>(set: (fn: (rows: R[]) => R[]) => void, row: Omit<R, "key">) {
    const added = { ...row, key: key() } as R;
    set((rows) => [...rows, added]);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const filledAllergies = allergies.filter((a) => a.substance.trim() || a.reaction.trim());
    if (nka && filledAllergies.length > 0) {
      setStatus({ kind: "nka" });
      return;
    }
    const body: HealthProfileInput = {
      version,
      blood_group: bloodGroup || null,
      allergies: nka
        ? [{ substance: NO_KNOWN_ALLERGIES }]
        : filledAllergies.map(({ substance, reaction, severity }) => ({ substance, reaction, severity })),
      medications: medications
        .filter((m) => m.name.trim() || m.dose.trim() || m.frequency.trim() || m.since.trim())
        .map(({ name, dose, frequency, since }) => ({ name, dose, frequency, since })),
      conditions: conditions
        .filter((c) => c.name.trim() || c.since.trim() || c.notes.trim())
        .map(({ name, since, notes }) => ({ name, since, notes })),
      birth_history: birth,
      developmental_history: development,
      emergency_contact_name: contactName,
      emergency_contact_phone: contactPhone,
    };
    setStatus({ kind: "saving" });
    try {
      const res = await fetch(`/api/family/children/${childId}/health`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as { profile?: HealthProfile; details?: Record<string, string> };
      if (!res.ok || !data.profile) {
        setStatus(healthSaveStatus(res.status, data.details));
        return;
      }
      setVersion(data.profile.version);
      setContactPhone(data.profile.emergency_contact_phone ?? "");
      setStatus({ kind: "saved" });
      router.refresh();
    } catch {
      setStatus({ kind: "failed" });
    }
  }

  const saving = status.kind === "saving";
  const addButton = (label: string, count: number, onClick: () => void) => (
    <button type="button" className={secondaryButtonClass} onClick={onClick} disabled={count >= MAX_ENTRIES}>
      {label}
    </button>
  );
  const removeButton = (index: number, onClick: () => void) => (
    <button type="button" className={secondaryButtonClass} onClick={onClick} aria-label={t("removeRow", { number: index + 1 })}>
      {t("remove")}
    </button>
  );
  const section = (name: HealthSection, children: ReactNode) => (
    <section aria-labelledby={`${id}-${name}`} className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4" data-section={name}>
      <h2 id={`${id}-${name}`} className="text-lg font-semibold text-slate-900">
        {ts(name)}
      </h2>
      {children}
    </section>
  );

  return (
    <form className="space-y-5" onSubmit={submit} aria-busy={saving}>
      {section(
        "allergies",
        <>
          <div className="flex items-center gap-3">
            <input
              id={`${id}-nka`}
              type="checkbox"
              className="h-5 w-5 shrink-0"
              checked={nka}
              onChange={(e) => {
                setNka(e.target.checked);
                if (status.kind === "nka") setStatus({ kind: "idle" });
              }}
            />
            <label htmlFor={`${id}-nka`} className="min-h-11 content-center text-slate-900">
              {t("nka")}
            </label>
          </div>
          {allergies.length === 0 && !nka ? <p className="text-sm text-slate-600">{t("none")}</p> : null}
          <ul className="space-y-3">
            {allergies.map((a, i) => (
              <li key={a.key}>
                <fieldset className="grid grid-cols-1 gap-3 rounded-xl bg-slate-50 p-3 sm:grid-cols-3">
                  <legend className="sr-only">{t("row", { number: i + 1 })}</legend>
                  <Field id={`${id}-a${a.key}-s`} label={tf("substance")}>
                    <input
                      id={`${id}-a${a.key}-s`}
                      name="allergy-substance"
                      className={inputClass}
                      required
                      maxLength={LIMITS.allergySubstance}
                      value={a.substance}
                      onChange={(e) => update(setAllergies, a.key, { substance: e.target.value })}
                    />
                  </Field>
                  <Field id={`${id}-a${a.key}-r`} label={tf("reaction")}>
                    <input
                      id={`${id}-a${a.key}-r`}
                      name="allergy-reaction"
                      className={inputClass}
                      maxLength={LIMITS.allergyReaction}
                      value={a.reaction}
                      onChange={(e) => update(setAllergies, a.key, { reaction: e.target.value })}
                    />
                  </Field>
                  <Field id={`${id}-a${a.key}-v`} label={tf("severity")}>
                    <select
                      id={`${id}-a${a.key}-v`}
                      name="allergy-severity"
                      className={inputClass}
                      value={a.severity}
                      onChange={(e) => update(setAllergies, a.key, { severity: e.target.value as AllergySeverity })}
                    >
                      {ALLERGY_SEVERITIES.map((s) => (
                        <option key={s} value={s}>
                          {tsev(s)}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <div className="sm:col-span-3">{removeButton(i, () => setAllergies((rows) => rows.filter((r) => r.key !== a.key)))}</div>
                </fieldset>
              </li>
            ))}
          </ul>
          {addButton(t("addAllergy"), allergies.length, () =>
            appendRow(setAllergies, { substance: "", reaction: "", severity: "unknown" }),
          )}
        </>,
      )}

      {section(
        "medications",
        <>
          {medications.length === 0 ? <p className="text-sm text-slate-600">{t("none")}</p> : null}
          <ul className="space-y-3">
            {medications.map((m, i) => (
              <li key={m.key}>
                <fieldset className="grid grid-cols-1 gap-3 rounded-xl bg-slate-50 p-3 sm:grid-cols-2">
                  <legend className="sr-only">{t("row", { number: i + 1 })}</legend>
                  <Field id={`${id}-m${m.key}-n`} label={tf("medicineName")}>
                    <input
                      id={`${id}-m${m.key}-n`}
                      name="medicine-name"
                      className={inputClass}
                      required
                      maxLength={LIMITS.medicationName}
                      value={m.name}
                      onChange={(e) => update(setMedications, m.key, { name: e.target.value })}
                    />
                  </Field>
                  <Field id={`${id}-m${m.key}-d`} label={tf("dose")}>
                    <input
                      id={`${id}-m${m.key}-d`}
                      name="medicine-dose"
                      className={inputClass}
                      maxLength={LIMITS.medicationDose}
                      value={m.dose}
                      onChange={(e) => update(setMedications, m.key, { dose: e.target.value })}
                    />
                  </Field>
                  <Field id={`${id}-m${m.key}-f`} label={tf("frequency")}>
                    <input
                      id={`${id}-m${m.key}-f`}
                      name="medicine-frequency"
                      className={inputClass}
                      maxLength={LIMITS.medicationFrequency}
                      value={m.frequency}
                      onChange={(e) => update(setMedications, m.key, { frequency: e.target.value })}
                    />
                  </Field>
                  <Field id={`${id}-m${m.key}-since`} label={tf("since")}>
                    <input
                      id={`${id}-m${m.key}-since`}
                      name="medicine-since"
                      className={inputClass}
                      inputMode="numeric"
                      placeholder="YYYY-MM"
                      pattern={MONTH_PATTERN}
                      maxLength={7}
                      value={m.since}
                      onChange={(e) => update(setMedications, m.key, { since: e.target.value })}
                    />
                  </Field>
                  <div className="sm:col-span-2">{removeButton(i, () => setMedications((rows) => rows.filter((r) => r.key !== m.key)))}</div>
                </fieldset>
              </li>
            ))}
          </ul>
          {addButton(t("addMedicine"), medications.length, () =>
            appendRow(setMedications, { name: "", dose: "", frequency: "", since: "" }),
          )}
        </>,
      )}

      {section(
        "conditions",
        <>
          {conditions.length === 0 ? <p className="text-sm text-slate-600">{t("none")}</p> : null}
          <ul className="space-y-3">
            {conditions.map((c, i) => (
              <li key={c.key}>
                <fieldset className="grid grid-cols-1 gap-3 rounded-xl bg-slate-50 p-3 sm:grid-cols-2">
                  <legend className="sr-only">{t("row", { number: i + 1 })}</legend>
                  <Field id={`${id}-c${c.key}-n`} label={tf("conditionName")}>
                    <input
                      id={`${id}-c${c.key}-n`}
                      name="condition-name"
                      className={inputClass}
                      required
                      maxLength={LIMITS.conditionName}
                      value={c.name}
                      onChange={(e) => update(setConditions, c.key, { name: e.target.value })}
                    />
                  </Field>
                  <Field id={`${id}-c${c.key}-since`} label={tf("since")}>
                    <input
                      id={`${id}-c${c.key}-since`}
                      name="condition-since"
                      className={inputClass}
                      inputMode="numeric"
                      placeholder="YYYY-MM"
                      pattern={MONTH_PATTERN}
                      maxLength={7}
                      value={c.since}
                      onChange={(e) => update(setConditions, c.key, { since: e.target.value })}
                    />
                  </Field>
                  <div className="sm:col-span-2">
                    <Field id={`${id}-c${c.key}-notes`} label={tf("notes")}>
                      <textarea
                        id={`${id}-c${c.key}-notes`}
                        name="condition-notes"
                        className={inputClass}
                        rows={2}
                        maxLength={LIMITS.conditionNotes}
                        value={c.notes}
                        onChange={(e) => update(setConditions, c.key, { notes: e.target.value })}
                      />
                    </Field>
                  </div>
                  <div className="sm:col-span-2">{removeButton(i, () => setConditions((rows) => rows.filter((r) => r.key !== c.key)))}</div>
                </fieldset>
              </li>
            ))}
          </ul>
          {addButton(t("addCondition"), conditions.length, () =>
            appendRow(setConditions, { name: "", since: "", notes: "" }),
          )}
        </>,
      )}

      {section(
        "birth_history",
        <>
          <p id={`${id}-birth-hint`} className="text-sm text-slate-600">
            {tf("birthHint")}
          </p>
          <textarea
            name="birth-history"
            aria-labelledby={`${id}-birth_history`}
            aria-describedby={`${id}-birth-hint`}
            className={inputClass}
            rows={4}
            maxLength={LIMITS.birthHistory}
            value={birth}
            onChange={(e) => setBirth(e.target.value)}
          />
        </>,
      )}

      {section(
        "developmental_history",
        <>
          <p id={`${id}-dev-hint`} className="text-sm text-slate-600">
            {tf("developmentHint")}
          </p>
          <textarea
            name="developmental-history"
            aria-labelledby={`${id}-developmental_history`}
            aria-describedby={`${id}-dev-hint`}
            className={inputClass}
            rows={5}
            maxLength={LIMITS.developmentalHistory}
            value={development}
            onChange={(e) => setDevelopment(e.target.value)}
          />
        </>,
      )}

      {section(
        "emergency_contact",
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field id={`${id}-ec-name`} label={tf("contactName")}>
            <input
              id={`${id}-ec-name`}
              name="emergency-contact-name"
              className={inputClass}
              autoComplete="off"
              maxLength={LIMITS.emergencyContactName}
              value={contactName}
              onChange={(e) => setContactName(e.target.value)}
            />
          </Field>
          <Field id={`${id}-ec-phone`} label={tf("contactPhone")}>
            <input
              id={`${id}-ec-phone`}
              name="emergency-contact-phone"
              className={inputClass}
              type="tel"
              autoComplete="off"
              placeholder="+91 98765 43210"
              maxLength={20}
              value={contactPhone}
              onChange={(e) => setContactPhone(e.target.value)}
            />
          </Field>
        </div>,
      )}

      {section(
        "blood_group",
        <select
          name="blood-group"
          aria-labelledby={`${id}-blood_group`}
          className={`${inputClass} sm:w-48`}
          value={bloodGroup}
          onChange={(e) => setBloodGroup(e.target.value as BloodGroup | "")}
        >
          <option value="">{t("bloodGroupNotSet")}</option>
          {BLOOD_GROUPS.map((g) => (
            <option key={g} value={g}>
              {g === "unknown" ? t("bloodGroupUnknown") : g}
            </option>
          ))}
        </select>,
      )}

      <div aria-live="polite">
        {status.kind === "saved" ? (
          <p role="status" className="rounded-xl bg-teal-50 px-4 py-3 text-sm font-medium text-teal-900">
            {t("saved")}
          </p>
        ) : null}
        {status.kind === "conflict" ? (
          <div role="alert" className="space-y-2 rounded-xl bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
            <p>{t("conflict")}</p>
            <button type="button" className={secondaryButtonClass} onClick={() => window.location.reload()}>
              {t("reload")}
            </button>
          </div>
        ) : null}
        {status.kind === "nka" || status.kind === "invalid" || status.kind === "failed" ? (
          <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
            {status.kind === "nka"
              ? t("nkaConflict")
              : status.kind === "invalid"
                ? t("invalid", { sections: status.sections.map((s) => ts(s)).join(", ") })
                : t("saveFailed")}
          </p>
        ) : null}
      </div>

      <button type="submit" className={`${primaryButtonClass} sm:w-auto`} disabled={saving}>
        {saving ? t("saving") : t("save")}
      </button>
    </form>
  );
}
