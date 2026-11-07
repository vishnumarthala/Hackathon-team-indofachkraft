"use client";

import { useState, type FormEvent } from "react";
import { fieldErrors, PILOT_ROLE_LABELS, PILOT_ROLES, PilotSignupSchema } from "@/lib/pilots";

const SUCCESS = "Thanks, you're on the pilot list. We'll contact you soon.";

const inputClass =
  "w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-base text-slate-900 focus:border-teal-600 focus:outline-none focus:ring-2 focus:ring-teal-600/30";

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} className="mt-1 text-sm text-red-700">
      {message}
    </p>
  );
}

export function PilotForm() {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<"idle" | "sending" | "done">("idle");

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const raw = Object.fromEntries(new FormData(e.currentTarget).entries());

    const parsed = PilotSignupSchema.safeParse(raw);
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return;
    }

    setErrors({});
    setStatus("sending");
    try {
      const res = await fetch("/api/pilot-signups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data),
      });
      if (res.ok) {
        setStatus("done");
        return;
      }
      const body: { details?: Record<string, string>; error?: string } = await res
        .json()
        .catch(() => ({}));
      setErrors(body.details ?? { body: body.error ?? "Something went wrong. Please try again." });
    } catch {
      setErrors({ body: "Network error. Please try again." });
    }
    setStatus("idle");
  }

  if (status === "done") {
    return (
      <p role="status" className="rounded-lg bg-teal-50 p-4 text-teal-900">
        {SUCCESS}
      </p>
    );
  }

  const describedBy = (field: string) => (errors[field] ? `${field}-error` : undefined);

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      <div>
        <label htmlFor="name" className="mb-1 block font-medium">
          Name
        </label>
        <input
          id="name"
          name="name"
          type="text"
          required
          maxLength={100}
          autoComplete="name"
          aria-invalid={Boolean(errors.name)}
          aria-describedby={describedBy("name")}
          className={inputClass}
        />
        <FieldError id="name-error" message={errors.name} />
      </div>

      <div>
        <label htmlFor="email" className="mb-1 block font-medium">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
          aria-invalid={Boolean(errors.email)}
          aria-describedby={describedBy("email")}
          className={inputClass}
        />
        <FieldError id="email-error" message={errors.email} />
      </div>

      <div>
        <label htmlFor="role" className="mb-1 block font-medium">
          I am a
        </label>
        <select
          id="role"
          name="role"
          required
          defaultValue=""
          aria-invalid={Boolean(errors.role)}
          aria-describedby={describedBy("role")}
          className={inputClass}
        >
          <option value="" disabled>
            Choose one
          </option>
          {PILOT_ROLES.map((r) => (
            <option key={r} value={r}>
              {PILOT_ROLE_LABELS[r]}
            </option>
          ))}
        </select>
        <FieldError id="role-error" message={errors.role} />
      </div>

      <div>
        <label htmlFor="country" className="mb-1 block font-medium">
          Country
        </label>
        <input
          id="country"
          name="country"
          type="text"
          required
          maxLength={60}
          autoComplete="country-name"
          aria-invalid={Boolean(errors.country)}
          aria-describedby={describedBy("country")}
          className={inputClass}
        />
        <FieldError id="country-error" message={errors.country} />
      </div>

      <div>
        <label htmlFor="centre" className="mb-1 block font-medium">
          Centre (optional)
        </label>
        <input
          id="centre"
          name="centre"
          type="text"
          maxLength={100}
          autoComplete="organization"
          aria-invalid={Boolean(errors.centre)}
          aria-describedby={describedBy("centre")}
          className={inputClass}
        />
        <FieldError id="centre-error" message={errors.centre} />
      </div>

      <div>
        <label htmlFor="clinicians" className="mb-1 block font-medium">
          Number of clinicians (optional)
        </label>
        <input
          id="clinicians"
          name="clinicians"
          type="number"
          inputMode="numeric"
          min={1}
          max={1000}
          step={1}
          aria-invalid={Boolean(errors.clinicians)}
          aria-describedby={describedBy("clinicians")}
          className={inputClass}
        />
        <FieldError id="clinicians-error" message={errors.clinicians} />
      </div>

      <div>
        <label htmlFor="note" className="mb-1 block font-medium">
          Anything we should know? (optional)
        </label>
        <textarea
          id="note"
          name="note"
          rows={3}
          maxLength={1000}
          aria-invalid={Boolean(errors.note)}
          aria-describedby={describedBy("note")}
          className={inputClass}
        />
        <FieldError id="note-error" message={errors.note} />
      </div>

      {/* Honeypot: hidden from people and assistive tech, never focusable. */}
      <div aria-hidden="true" className="absolute -left-[10000px] top-auto h-px w-px overflow-hidden">
        <label htmlFor="website">Website</label>
        <input id="website" name="website" type="text" tabIndex={-1} autoComplete="off" />
      </div>

      <FieldError id="body-error" message={errors.body} />

      <button
        type="submit"
        disabled={status === "sending"}
        className="w-full rounded-md bg-teal-700 px-5 py-3 font-semibold text-white hover:bg-teal-800 disabled:opacity-60 sm:w-auto"
      >
        Join the pilot
      </button>
    </form>
  );
}
