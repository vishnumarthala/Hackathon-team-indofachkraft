"use client";

import { useState, type FormEvent } from "react";
import { fieldErrors, PILOT_ROLE_LABELS, PILOT_ROLES, PilotSignupSchema } from "@/lib/pilots";

const SUCCESS = "Thanks, you're on the pilot list. We'll contact you soon.";

const inputClass =
  "w-full rounded-xl border border-slate-300 bg-slate-50/60 px-4 py-3 text-base text-slate-900 transition-colors duration-200 placeholder:text-slate-400 hover:border-slate-400 focus:border-teal-600 focus:bg-white focus:outline-none focus:ring-4 focus:ring-teal-600/15 aria-[invalid=true]:border-red-400 aria-[invalid=true]:bg-red-50/40";

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
      <div role="status" className="flex flex-col items-center px-2 py-10 text-center">
        <span className="mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-teal-100 text-teal-700 ring-8 ring-teal-50">
          <svg className="h-8 w-8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m5 12.5 4.5 4.5L19 7.5" />
          </svg>
        </span>
        <p className="text-lg font-semibold text-slate-900">{SUCCESS}</p>
      </div>
    );
  }

  const describedBy = (field: string) => (errors[field] ? `${field}-error` : undefined);

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      <div>
        <label htmlFor="name" className="mb-1.5 block text-sm font-semibold text-slate-800">
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
        <label htmlFor="email" className="mb-1.5 block text-sm font-semibold text-slate-800">
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
        <label htmlFor="role" className="mb-1.5 block text-sm font-semibold text-slate-800">
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
        <label htmlFor="country" className="mb-1.5 block text-sm font-semibold text-slate-800">
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
        <label htmlFor="centre" className="mb-1.5 block text-sm font-semibold text-slate-800">
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
        <label htmlFor="clinicians" className="mb-1.5 block text-sm font-semibold text-slate-800">
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
        <label htmlFor="note" className="mb-1.5 block text-sm font-semibold text-slate-800">
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
        className="min-h-12 w-full cursor-pointer rounded-full bg-teal-700 px-7 py-3 font-semibold text-white shadow-lg shadow-teal-700/25 transition-all duration-200 hover:bg-teal-800 hover:shadow-xl active:scale-[0.98] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-600/40 disabled:cursor-wait disabled:opacity-60"
      >
        {status === "sending" ? "Sending…" : "Join the pilot"}
      </button>
    </form>
  );
}
