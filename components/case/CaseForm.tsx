"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";

type FieldErrors = Record<string, string>;

const inputClass = "mt-1 block w-full rounded border border-slate-300 px-3 py-2 text-sm";

function Field({
  id,
  label,
  error,
  children,
}: {
  id: string;
  label: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-slate-800">
        {label}
      </label>
      {children}
      {error && (
        <p id={`${id}-error`} className="mt-1 text-sm text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}

export type OrgOption = { id: string; name: string };

export function CaseForm({ orgs = [] }: { orgs?: OrgOption[] }) {
  const router = useRouter();
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setErrors({});
    setFormError(null);
    const form = new FormData(event.currentTarget);
    const body = Object.fromEntries(
      ["child_alias", "child_age_months", "parent_alias", "parent_email", "parent_phone", "language", "therapist_name"].map(
        (key) => [key, String(form.get(key) ?? "")],
      ),
    );
    if (orgs.length > 1) body.org_id = String(form.get("org_id") ?? "");
    try {
      const res = await fetch("/api/cases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (res.status === 201 && json.case?.id) {
        router.push(`/cases/${json.case.id}`);
        return;
      }
      if (res.status === 400 && json.details) setErrors(json.details);
      else setFormError(json.error ?? "Could not create the case");
    } catch {
      setFormError("Could not create the case");
    }
    setSubmitting(false);
  }

  const describedBy = (id: string) => (errors[id] ? `${id}-error` : undefined);

  return (
    <form onSubmit={onSubmit} noValidate className="max-w-lg space-y-4">
      <p className="rounded bg-yellow-50 px-3 py-2 text-sm text-yellow-900">Use made-up names only (synthetic data).</p>
      {orgs.length > 1 && (
        <Field id="org_id" label="Organisation" error={errors.org_id}>
          <select id="org_id" name="org_id" required defaultValue="" className={inputClass} aria-describedby={describedBy("org_id")}>
            <option value="" disabled>
              Choose an organisation
            </option>
            {orgs.map((org) => (
              <option key={org.id} value={org.id}>
                {org.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field id="child_alias" label="Child alias" error={errors.child_alias}>
        <input id="child_alias" name="child_alias" required maxLength={60} className={inputClass} aria-describedby={describedBy("child_alias")} />
      </Field>
      <Field id="child_age_months" label="Child age (months)" error={errors.child_age_months}>
        <input id="child_age_months" name="child_age_months" type="number" min={12} max={216} inputMode="numeric" className={inputClass} aria-describedby={describedBy("child_age_months")} />
      </Field>
      <Field id="parent_alias" label="Parent alias" error={errors.parent_alias}>
        <input id="parent_alias" name="parent_alias" required maxLength={60} className={inputClass} aria-describedby={describedBy("parent_alias")} />
      </Field>
      <Field id="parent_email" label="Parent email" error={errors.parent_email}>
        <input id="parent_email" name="parent_email" type="email" className={inputClass} aria-describedby={describedBy("parent_email")} />
      </Field>
      <Field id="parent_phone" label="Parent phone (WhatsApp)" error={errors.parent_phone}>
        <input id="parent_phone" name="parent_phone" type="tel" className={inputClass} aria-describedby={describedBy("parent_phone")} />
      </Field>
      <Field id="language" label="Language" error={errors.language}>
        <select id="language" name="language" defaultValue="en" className={inputClass} aria-describedby={describedBy("language")}>
          <option value="en">English</option>
          <option value="hi">Hindi</option>
          <option value="te">Telugu</option>
        </select>
      </Field>
      <Field id="therapist_name" label="Therapist name" error={errors.therapist_name}>
        <input id="therapist_name" name="therapist_name" defaultValue="Demo Therapist" maxLength={60} className={inputClass} aria-describedby={describedBy("therapist_name")} />
      </Field>
      {formError && <p className="text-sm text-red-700">{formError}</p>}
      <Button type="submit" disabled={submitting}>
        Create case
      </Button>
    </form>
  );
}
