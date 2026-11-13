"use client";

import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { inputClass, primaryButtonClass } from "@/components/family/PhoneOtpForm";
import { RELATIONSHIPS } from "@/lib/consent/features";
import { useT } from "@/lib/i18n/client";

const SEXES = ["female", "male", "other", "undisclosed"] as const;
type Field = "display_name" | "date_of_birth" | "relationship" | "declaration";

/** Client-side checks mirror ChildCreateSchema; the server validates again. */
export function validateChild(input: { name: string; dob: string; relationship: string; declaration: boolean }, today: string) {
  const errors: Partial<Record<Field, true>> = {};
  const name = input.name.trim();
  if (name.length < 1 || name.length > 60) errors.display_name = true;
  if (input.dob && (!/^\d{4}-\d{2}-\d{2}$/.test(input.dob) || input.dob > today)) errors.date_of_birth = true;
  if (!(RELATIONSHIPS as readonly string[]).includes(input.relationship)) errors.relationship = true;
  if (!input.declaration) errors.declaration = true;
  return errors;
}

// 020 FR-11: name, optional DOB and sex, relationship and the guardian declaration. `next` (030): return to the
// booking flow after adding a child (the page passes only a safe /book/ path).
export function AddChildForm({ next }: { next?: string } = {}) {
  const t = useT("family.children.form");
  const router = useRouter();
  const id = useId();
  const [name, setName] = useState("");
  const [dob, setDob] = useState("");
  const [sex, setSex] = useState("");
  const [relationship, setRelationship] = useState("");
  const [declaration, setDeclaration] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<Field, true>>>({});
  const [status, setStatus] = useState<"idle" | "saving" | "failed">("idle");
  const today = new Date().toISOString().slice(0, 10);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const found = validateChild({ name, dob, relationship, declaration }, today);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setStatus("saving");
    try {
      const res = await fetch("/api/family/children", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          display_name: name.trim(),
          date_of_birth: dob || null,
          sex: sex || null,
          relationship,
          declaration: true,
        }),
      });
      if (res.status === 400) {
        const body = (await res.json().catch(() => ({}))) as { details?: Record<string, string> };
        setErrors(Object.fromEntries(Object.keys(body.details ?? {}).map((k) => [k, true])) as Partial<Record<Field, true>>);
        setStatus("idle");
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { child?: { id: string } };
      if (res.status !== 201 || !body.child) throw new Error(String(res.status));
      router.push(next ?? `/family/children/${body.child.id}`);
      router.refresh();
    } catch {
      setStatus("failed");
    }
  }

  const err = (field: Field, key: Parameters<typeof t>[0]) =>
    errors[field] ? (
      <p id={`${id}-${field}-error`} role="alert" className="text-sm font-medium text-red-700">
        {t(key)}
      </p>
    ) : null;
  const describedBy = (field: Field, hint?: string) =>
    [hint, errors[field] ? `${id}-${field}-error` : null].filter(Boolean).join(" ") || undefined;

  return (
    <form className="space-y-5" onSubmit={submit} noValidate>
      <div className="space-y-2">
        <label htmlFor={`${id}-name`} className="block text-sm font-semibold text-slate-900">
          {t("name")}
        </label>
        <input
          id={`${id}-name`}
          className={inputClass}
          maxLength={60}
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-invalid={errors.display_name ? true : undefined}
          aria-describedby={describedBy("display_name", `${id}-name-hint`)}
        />
        <p id={`${id}-name-hint`} className="text-sm text-slate-600">
          {t("nameHint")}
        </p>
        {err("display_name", "nameError")}
      </div>
      <div className="space-y-2">
        <label htmlFor={`${id}-dob`} className="block text-sm font-semibold text-slate-900">
          {t("dob")}
        </label>
        <input
          id={`${id}-dob`}
          type="date"
          max={today}
          className={inputClass}
          value={dob}
          onChange={(e) => setDob(e.target.value)}
          aria-invalid={errors.date_of_birth ? true : undefined}
          aria-describedby={describedBy("date_of_birth")}
        />
        {err("date_of_birth", "dobError")}
      </div>
      <div className="space-y-2">
        <label htmlFor={`${id}-sex`} className="block text-sm font-semibold text-slate-900">
          {t("sex")}
        </label>
        <select id={`${id}-sex`} className={inputClass} value={sex} onChange={(e) => setSex(e.target.value)}>
          <option value="">{t("choose")}</option>
          {SEXES.map((s) => (
            <option key={s} value={s}>
              {t(`sexOptions.${s}`)}
            </option>
          ))}
        </select>
      </div>
      <RelationshipSelect
        id={`${id}-rel`}
        value={relationship}
        onChange={setRelationship}
        invalid={Boolean(errors.relationship)}
        errorId={errors.relationship ? `${id}-relationship-error` : undefined}
      />
      {err("relationship", "relationshipError")}
      <DeclarationCheckbox
        id={`${id}-decl`}
        checked={declaration}
        onChange={setDeclaration}
        errorId={errors.declaration ? `${id}-declaration-error` : undefined}
      />
      {err("declaration", "declarationError")}
      {status === "failed" ? (
        <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
          {t("saveFailed")}
        </p>
      ) : null}
      <button type="submit" className={`${primaryButtonClass} sm:w-auto`} disabled={status === "saving"}>
        {status === "saving" ? t("saving") : t("submit")}
      </button>
    </form>
  );
}

export function RelationshipSelect({
  id,
  value,
  onChange,
  invalid,
  errorId,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  invalid: boolean;
  errorId?: string;
}) {
  const t = useT("family.children.form");
  return (
    <div className="space-y-2">
      <label htmlFor={id} className="block text-sm font-semibold text-slate-900">
        {t("relationship")}
      </label>
      <select
        id={id}
        className={inputClass}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={invalid ? true : undefined}
        aria-describedby={errorId}
      >
        <option value="">{t("choose")}</option>
        {RELATIONSHIPS.map((r) => (
          <option key={r} value={r}>
            {t(`relationships.${r}`)}
          </option>
        ))}
      </select>
    </div>
  );
}

export function DeclarationCheckbox({
  id,
  checked,
  onChange,
  errorId,
}: {
  id: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  errorId?: string;
}) {
  const t = useT("family.children.form");
  return (
    <div className="flex items-start gap-3">
      <input
        id={id}
        type="checkbox"
        className="mt-1 h-5 w-5 shrink-0"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        aria-invalid={errorId ? true : undefined}
        aria-describedby={errorId}
      />
      <label htmlFor={id} className="text-base text-slate-900">
        {t("declaration")}
      </label>
    </div>
  );
}
