"use client";

import Link from "next/link";
import { useRef, useState, type FormEvent } from "react";
import { fieldErrors, MSG, PilotSignupSchema, type PilotRole } from "@/lib/pilots";
import { Arrow } from "./ui";

const SUCCESS = "Thanks, you're on the pilot list. We'll contact you soon.";

const ROLES: { value: PilotRole; title: string; text: string; icon: string }[] = [
  { value: "therapist", title: "Therapist", text: "I run early intervention sessions", icon: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 8a7 7 0 0 1 14 0" },
  { value: "centre_owner", title: "Centre owner / manager", text: "I run a centre or a practice", icon: "M3 21h18M5 21V7l7-4 7 4v14M9 21v-6h6v6" },
  { value: "psychologist", title: "Child psychologist", text: "I assess children and refer them", icon: "M9 12l2 2 4-4M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z" },
  { value: "parent", title: "Parent", text: "I'd like my child's centre to use it", icon: "M4 6h16v10H8l-4 4V6Z" },
  { value: "other", title: "Something else", text: "Researcher, partner, investor", icon: "M12 8v4m0 4h.01M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z" },
];

const PROFESSIONAL: PilotRole[] = ["therapist", "psychologist", "centre_owner"];

const inputClass =
  "w-full rounded-xl border border-[#0b1f1d]/15 bg-white px-4 py-3 text-base text-[#0b1f1d] transition-[border-color,box-shadow] duration-200 placeholder:text-slate-400 hover:border-[#0b1f1d]/30 focus:border-teal-600 focus:outline-none focus:ring-4 focus:ring-teal-600/15 aria-[invalid=true]:border-red-400 aria-[invalid=true]:bg-red-50/40";

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} className="mt-1.5 text-sm font-medium text-red-700">
      {message}
    </p>
  );
}

function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-semibold text-[#0b1f1d]">
        {label}
      </label>
      {children}
      {hint && !error ? <p className="mt-1.5 text-xs text-slate-500">{hint}</p> : null}
      <FieldError id={`${id}-error`} message={error} />
    </div>
  );
}

export function DemoRequestForm() {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [role, setRole] = useState<PilotRole | "">("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const topRef = useRef<HTMLDivElement | null>(null);

  const isPro = role !== "" && PROFESSIONAL.includes(role);
  const describedBy = (f: string) => (errors[f] ? `${f}-error` : undefined);

  function goTo(next: 1 | 2 | 3) {
    setStep(next);
    topRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function continueFromRole() {
    if (!role) {
      setErrors({ role: MSG.role });
      return;
    }
    setErrors({});
    goTo(2);
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const raw = { ...Object.fromEntries(new FormData(e.currentTarget).entries()), role };
    const parsed = PilotSignupSchema.safeParse(raw);
    if (!parsed.success) {
      const errs = fieldErrors(parsed.error);
      setErrors(errs);
      if (errs.role) goTo(1);
      return;
    }

    setErrors({});
    setSending(true);
    try {
      const res = await fetch("/api/pilot-signups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data),
      });
      if (res.ok) {
        goTo(3);
        return;
      }
      const body: { details?: Record<string, string>; error?: string } = await res.json().catch(() => ({}));
      setErrors(body.details ?? { body: body.error ?? "Something went wrong. Please try again." });
    } catch {
      setErrors({ body: "Network error. Please check your connection and try again." });
    } finally {
      setSending(false);
    }
  }

  if (step === 3) {
    return (
      <div ref={topRef} role="status" className="lp-step-in py-4">
        <span className="mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-teal-100 text-teal-700 ring-8 ring-teal-50">
          <svg className="h-8 w-8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m5 12.5 4.5 4.5L19 7.5" />
          </svg>
        </span>
        <h2 className="lp-display text-4xl text-[#0b1f1d]">You&apos;re in.</h2>
        <p className="mt-2 text-lg font-medium text-[#0b1f1d]">{SUCCESS}</p>
        <ol className="mt-8 space-y-4">
          {[
            ["Within one working day", "We email you to pick a time for the demo call."],
            ["On the call", "We walk through a sample case: intake, session, ISAA and referral."],
            ["After the call", "If it fits, we set up your workspace and send your logins."],
          ].map(([t, x], i) => (
            <li key={t} className="flex gap-4">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#0b1f1d] text-xs font-semibold text-white">{i + 1}</span>
              <div>
                <p className="font-semibold text-[#0b1f1d]">{t}</p>
                <p className="text-sm text-slate-600">{x}</p>
              </div>
            </li>
          ))}
        </ol>
        <Link href="/" className="mt-10 inline-flex items-center gap-1.5 text-sm font-semibold text-teal-800 hover:text-teal-900">
          Back to the home page <Arrow className="h-3.5 w-3.5" />
        </Link>
      </div>
    );
  }

  return (
    <div ref={topRef} className="scroll-mt-24">
      {/* Progress */}
      <div className="mb-8 flex items-center gap-3" aria-label={`Step ${step} of 2`}>
        {[1, 2].map((n) => (
          <div key={n} className="flex flex-1 items-center gap-3">
            <span
              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold transition-colors duration-300 ${
                step >= n ? "bg-[#0b1f1d] text-white" : "bg-[#0b1f1d]/[0.06] text-slate-500"
              }`}
            >
              {step > n ? "✓" : n}
            </span>
            <span className={`text-sm font-medium ${step >= n ? "text-[#0b1f1d]" : "text-slate-500"}`}>
              {n === 1 ? "About you" : "Your details"}
            </span>
            {n === 1 && <span className={`h-px flex-1 transition-colors duration-500 ${step > 1 ? "bg-[#0b1f1d]" : "bg-[#0b1f1d]/15"}`} />}
          </div>
        ))}
      </div>

      {step === 1 ? (
        <div className="lp-step-in">
          <fieldset aria-describedby={describedBy("role")}>
            <legend className="mb-1 text-2xl font-semibold text-[#0b1f1d]">I am a</legend>
            <p className="mb-5 text-sm text-slate-600">Pick the one that fits best. It helps us prepare the right demo.</p>
            <div className="grid gap-3">
              {ROLES.map((r) => {
                const checked = role === r.value;
                return (
                  <label
                    key={r.value}
                    className={`flex min-h-16 cursor-pointer items-center gap-4 rounded-2xl border p-4 transition-all duration-200 has-[:focus-visible]:ring-4 has-[:focus-visible]:ring-teal-600/25 ${
                      checked
                        ? "border-teal-600 bg-teal-50/70 shadow-md shadow-teal-900/5"
                        : "border-[#0b1f1d]/12 bg-white hover:border-[#0b1f1d]/30"
                    }`}
                  >
                    <input
                      type="radio"
                      name="role-choice"
                      value={r.value}
                      checked={checked}
                      onChange={() => {
                        setRole(r.value);
                        setErrors({});
                      }}
                      className="sr-only"
                    />
                    <span
                      className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${
                        checked ? "bg-teal-700 text-white" : "bg-[#f8f6f1] text-teal-700"
                      }`}
                    >
                      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d={r.icon} />
                      </svg>
                    </span>
                    <span className="flex-1">
                      <span className="block font-semibold text-[#0b1f1d]">{r.title}</span>
                      <span className="block text-sm text-slate-600">{r.text}</span>
                    </span>
                    <span
                      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 ${
                        checked ? "border-teal-700 bg-teal-700" : "border-[#0b1f1d]/20"
                      }`}
                      aria-hidden="true"
                    >
                      {checked && <span className="h-2 w-2 rounded-full bg-white" />}
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>
          <FieldError id="role-error" message={errors.role} />

          <button
            type="button"
            onClick={continueFromRole}
            className="lp-btn mt-7 inline-flex min-h-13 w-full cursor-pointer items-center justify-center gap-2 rounded-full bg-[#0b1f1d] px-7 py-3.5 font-semibold text-white hover:bg-teal-800 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-600/40"
          >
            Continue
            <Arrow />
          </button>
        </div>
      ) : (
        <form onSubmit={onSubmit} noValidate className="lp-step-in space-y-5">
          <div className="flex items-center justify-between gap-3 rounded-2xl bg-white px-4 py-3 ring-1 ring-[#0b1f1d]/10">
            <p className="text-sm text-slate-600">
              Booking as <span className="font-semibold text-[#0b1f1d]">{ROLES.find((r) => r.value === role)?.title}</span>
            </p>
            <button type="button" onClick={() => goTo(1)} className="cursor-pointer text-sm font-semibold text-teal-800 underline-offset-4 hover:underline">
              Change
            </button>
          </div>

          {role === "parent" && (
            <p className="rounded-2xl border border-teal-200 bg-teal-50/60 p-4 text-sm leading-relaxed text-teal-900">
              Parents never need an account: your therapist sends you a link. Leave your details and tell us your
              child&apos;s centre, and we will reach out to them.
            </p>
          )}

          <Field id="name" label="Name" error={errors.name}>
            <input id="name" name="name" type="text" maxLength={100} autoComplete="name" aria-invalid={Boolean(errors.name)} aria-describedby={describedBy("name")} className={inputClass} />
          </Field>

          <Field id="email" label="Email" hint={isPro ? "Your work email, so we can set up your workspace." : undefined} error={errors.email}>
            <input id="email" name="email" type="email" autoComplete="email" aria-invalid={Boolean(errors.email)} aria-describedby={describedBy("email")} className={inputClass} />
          </Field>

          <Field id="country" label="Country" error={errors.country}>
            <input id="country" name="country" type="text" list="lp-countries" maxLength={60} autoComplete="country-name" aria-invalid={Boolean(errors.country)} aria-describedby={describedBy("country")} className={inputClass} />
            <datalist id="lp-countries">
              <option value="Germany" />
              <option value="India" />
              <option value="Austria" />
              <option value="Switzerland" />
            </datalist>
          </Field>

          <div className={isPro || role === "parent" ? "grid items-end gap-5 sm:grid-cols-2" : "hidden"}>
            <Field id="centre" label="Centre (optional)" error={errors.centre}>
              <input id="centre" name="centre" type="text" maxLength={100} autoComplete="organization" aria-invalid={Boolean(errors.centre)} aria-describedby={describedBy("centre")} className={inputClass} />
            </Field>
            {isPro && (
              <Field id="clinicians" label="Number of clinicians (optional)" error={errors.clinicians}>
                <input id="clinicians" name="clinicians" type="number" inputMode="numeric" min={1} max={1000} step={1} aria-invalid={Boolean(errors.clinicians)} aria-describedby={describedBy("clinicians")} className={inputClass} />
              </Field>
            )}
          </div>

          <Field id="note" label="Anything we should know? (optional)" error={errors.note}>
            <textarea id="note" name="note" rows={3} maxLength={1000} placeholder="E.g. how many children you assess each month" aria-invalid={Boolean(errors.note)} aria-describedby={describedBy("note")} className={inputClass} />
          </Field>

          {/* Honeypot: hidden from people and assistive tech, never focusable. */}
          <div aria-hidden="true" className="absolute -left-[10000px] top-auto h-px w-px overflow-hidden">
            <label htmlFor="website">Website</label>
            <input id="website" name="website" type="text" tabIndex={-1} autoComplete="off" />
          </div>

          <FieldError id="body-error" message={errors.body} />

          <div className="flex flex-col-reverse gap-3 pt-2 sm:flex-row">
            <button
              type="button"
              onClick={() => goTo(1)}
              className="lp-btn min-h-13 cursor-pointer rounded-full border border-[#0b1f1d]/15 px-6 py-3 font-semibold text-[#0b1f1d] hover:border-[#0b1f1d]/40 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-600/30"
            >
              Back
            </button>
            <button
              type="submit"
              disabled={sending}
              className="lp-btn inline-flex min-h-13 flex-1 cursor-pointer items-center justify-center gap-2 rounded-full bg-[#0b1f1d] px-7 py-3 font-semibold text-white hover:bg-teal-800 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-600/40 disabled:cursor-wait disabled:opacity-60"
            >
              {sending ? "Sending…" : role === "parent" ? "Send" : "Book my demo"}
              {!sending && <Arrow />}
            </button>
          </div>
          <p className="text-center text-xs text-slate-500">We only use your details to contact you about CareThread.</p>
        </form>
      )}
    </div>
  );
}
