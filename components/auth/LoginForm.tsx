"use client";

import { useState, type FormEvent } from "react";
import { supabaseBrowser } from "@/lib/supabase-browser";

const inputClass =
  "mt-1.5 block w-full rounded-xl border border-[#0b1f1d]/15 bg-white px-4 py-3 text-base text-[#0b1f1d] transition-[border-color,box-shadow] duration-200 hover:border-[#0b1f1d]/30 focus:border-teal-600 focus:outline-none focus:ring-4 focus:ring-teal-600/15";

export function LoginForm({ nextPath }: { nextPath: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorMessage("");
    setSubmitting(true);

    const { error } = await supabaseBrowser().auth.signInWithPassword({ email, password });
    if (error) {
      setErrorMessage("Unable to sign in. Check your email and password, then try again.");
      setSubmitting(false);
      return;
    }

    window.location.assign(nextPath);
  }

  return (
    <div className="w-full">
      <h1 className="lp-display mb-2 text-5xl text-[#0b1f1d]">Welcome back</h1>
      <p className="mb-8 text-slate-600">Sign in to CareThread with the email and password from your centre&apos;s administrator.</p>
      <form className="space-y-5" onSubmit={submit}>
        <label className="block text-sm font-semibold text-[#0b1f1d]">
          Email
          <input
            autoComplete="email"
            className={inputClass}
            onChange={(event) => setEmail(event.target.value)}
            required
            type="email"
            value={email}
          />
        </label>
        <div>
          <label htmlFor="login-password" className="block text-sm font-semibold text-[#0b1f1d]">
            Password
          </label>
          <div className="relative">
            <input
              id="login-password"
              autoComplete="current-password"
              className={`${inputClass} pr-20`}
              onChange={(event) => setPassword(event.target.value)}
              required
              type={showPassword ? "text" : "password"}
              value={password}
            />
            <button
              type="button"
              onClick={() => setShowPassword((s) => !s)}
              aria-pressed={showPassword}
              className="absolute right-2 top-1/2 mt-[3px] -translate-y-1/2 cursor-pointer rounded-lg px-3 py-1.5 text-xs font-semibold text-teal-800 hover:bg-teal-50"
            >
              {showPassword ? "Hide" : "Show"}
            </button>
          </div>
        </div>
        {errorMessage ? (
          <p aria-live="polite" className="rounded-xl bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
            {errorMessage}
          </p>
        ) : null}
        <button
          className="lp-btn min-h-13 w-full cursor-pointer rounded-full bg-[#0b1f1d] px-6 py-3.5 font-semibold text-white hover:bg-teal-800 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-600/40 disabled:cursor-wait disabled:opacity-60"
          disabled={submitting}
          type="submit"
        >
          {submitting ? "Signing in..." : "Sign in"}
        </button>
      </form>
    </div>
  );
}
