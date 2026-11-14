import { useId, type ComponentProps, type ReactNode } from "react";
import { focusRing } from "./variants";
import { cn } from "./cn";

// Figma: Components › Text field (5:4, Default/Focus/Error/Disabled) and Select (5:25).
export const controlClasses =
  "block min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-base text-slate-900 " +
  "focus-visible:border-teal-600 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500 " +
  "aria-invalid:border-red-600 " +
  focusRing;

type FieldProps = { label: ReactNode; hint?: ReactNode; error?: ReactNode; className?: string };

function Field({ id, label, hint, error, className, children }: FieldProps & { id: string; children: ReactNode }) {
  return (
    <div className={cn("space-y-1", className)}>
      <label htmlFor={id} className="block text-sm font-medium text-slate-800">
        {label}
      </label>
      {children}
      {hint ? (
        <p id={`${id}-hint`} className="text-sm text-slate-600">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="text-sm text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function describedBy(id: string, hint: unknown, error: unknown, own?: string) {
  return [own, hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(" ") || undefined;
}

/** Figma Text field: label + input + optional hint and error (wired with aria-describedby / aria-invalid). */
export function TextField({ label, hint, error, className, id, ...input }: FieldProps & Omit<ComponentProps<"input">, "className">) {
  const auto = useId();
  const fieldId = id ?? auto;
  return (
    <Field id={fieldId} label={label} hint={hint} error={error} className={className}>
      <input
        id={fieldId}
        className={controlClasses}
        aria-invalid={error ? true : undefined}
        {...input}
        aria-describedby={describedBy(fieldId, hint, error, input["aria-describedby"])}
      />
    </Field>
  );
}

/** Figma Select: label + native select (keeps the platform picker on low-end Android phones). */
export function Select({ label, hint, error, className, id, children, ...select }: FieldProps & Omit<ComponentProps<"select">, "className">) {
  const auto = useId();
  const fieldId = id ?? auto;
  return (
    <Field id={fieldId} label={label} hint={hint} error={error} className={className}>
      <select
        id={fieldId}
        className={controlClasses}
        aria-invalid={error ? true : undefined}
        {...select}
        aria-describedby={describedBy(fieldId, hint, error, select["aria-describedby"])}
      >
        {children}
      </select>
    </Field>
  );
}
