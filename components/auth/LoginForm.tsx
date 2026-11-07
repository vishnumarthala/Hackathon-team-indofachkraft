"use client";

import { useState, type FormEvent } from "react";
import { supabaseBrowser } from "@/lib/supabase-browser";

export function LoginForm({ nextPath }: { nextPath: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
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
    <main className="mx-auto w-full max-w-md px-4 py-16">
      <h1 className="mb-2 text-3xl font-bold text-slate-900">Sign in to CareThread</h1>
      <p className="mb-6 text-sm text-slate-600">Use the email and password provided by your administrator.</p>
      <form className="space-y-4" onSubmit={submit}>
        <label className="block text-sm font-medium text-slate-800">
          Email
          <input
            autoComplete="email"
            className="mt-1 block w-full rounded border border-slate-300 px-3 py-2"
            onChange={(event) => setEmail(event.target.value)}
            required
            type="email"
            value={email}
          />
        </label>
        <label className="block text-sm font-medium text-slate-800">
          Password
          <input
            autoComplete="current-password"
            className="mt-1 block w-full rounded border border-slate-300 px-3 py-2"
            onChange={(event) => setPassword(event.target.value)}
            required
            type="password"
            value={password}
          />
        </label>
        {errorMessage ? (
          <p aria-live="polite" className="text-sm text-red-700">
            {errorMessage}
          </p>
        ) : null}
        <button
          className="w-full rounded bg-teal-700 px-4 py-2 font-semibold text-white hover:bg-teal-800 disabled:opacity-60"
          disabled={submitting}
          type="submit"
        >
          {submitting ? "Signing in..." : "Sign in"}
        </button>
      </form>
    </main>
  );
}
