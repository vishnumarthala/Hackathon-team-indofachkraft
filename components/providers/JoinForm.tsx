"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { useT } from "@/lib/i18n/client";
import { PROVIDER_TYPES, type ProviderType } from "@/lib/providers/constants";
import { supabaseBrowser } from "@/lib/supabase-browser";
import { buttonClass, fieldKeys, inputClass, labelClass, secondaryButtonClass, send } from "./request";

type Props = {
  signedInEmail: string | null;
  googleEnabled: boolean;
  // Claim flow: create/sign in to an account, then go back to the claim link instead of registering.
  claimPath: string | null;
  // Prefill for signed-in users (from the account's metadata, e.g. after Google or email confirmation).
  defaultName?: string;
  defaultType?: ProviderType | null;
};

export function JoinForm({ signedInEmail, googleEnabled, claimPath, defaultName = "", defaultType = null }: Props) {
  const t = useT("providers");
  const [providerType, setProviderType] = useState<ProviderType | "">(defaultType ?? "");
  const [fullName, setFullName] = useState(defaultName);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [invalid, setInvalid] = useState<string[]>([]);


  async function register(): Promise<boolean> {
    const res = await send("/api/providers/register", "POST", { provider_type: providerType, full_name: fullName });
    if (res.ok) {
      window.location.assign(String(res.json.redirect ?? "/dashboard/profile"));
      return true;
    }
    setInvalid(fieldKeys(res.json));
    setError(res.status === 403 ? t("join.notAllowed") : res.status === 400 ? t("form.invalid") : t("form.failed"));
    return false;
  }

  async function onRegister(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    if (!(await register())) setBusy(false);
  }

  async function onSignUp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setInfo("");
    setInvalid([]);
    const res = await send("/api/providers/join", "POST", {
      ...(claimPath ? {} : { provider_type: providerType }),
      full_name: fullName,
      email,
      password,
    });
    if (!res.ok) {
      setInvalid(fieldKeys(res.json));
      setError(
        res.status === 409
          ? t("join.exists")
          : res.status === 429
            ? t("join.tooMany")
            : res.status === 400
              ? t("form.invalid")
              : t("form.failed"),
      );
      setBusy(false);
      return;
    }
    if (res.json.confirm_email) {
      setInfo(t("join.checkEmail"));
      setBusy(false);
      return;
    }
    const { error: signInError } = await supabaseBrowser().auth.signInWithPassword({ email, password });
    if (signInError) {
      setError(t("join.signInFailed"));
      setBusy(false);
      return;
    }
    if (claimPath) {
      window.location.assign(claimPath);
      return;
    }
    if (!(await register())) setBusy(false);
  }

  async function onGoogle() {
    // /auth/callback (019) exchanges the code and returns here: onboarding paths are allowed for every role.
    const next = encodeURIComponent(claimPath ?? "/join");
    await supabaseBrowser().auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/auth/callback?next=${next}` },
    });
  }

  const typeField = (
    <div>
      <label htmlFor="join-type" className={labelClass}>
        {t("join.iAm")}
      </label>
      <select
        id="join-type"
        required
        value={providerType}
        aria-invalid={invalid.includes("provider_type")}
        onChange={(e) => setProviderType(e.target.value as ProviderType)}
        className={inputClass}
      >
        <option value="" disabled>
          {t("join.choose")}
        </option>
        {PROVIDER_TYPES.map((type) => (
          <option key={type} value={type}>
            {t(`types.${type}`)}
          </option>
        ))}
      </select>
    </div>
  );

  const nameField = (
    <div>
      <label htmlFor="join-name" className={labelClass}>
        {t("join.fullName")}
      </label>
      <input
        id="join-name"
        required
        maxLength={120}
        autoComplete="name"
        value={fullName}
        aria-invalid={invalid.includes("full_name")}
        onChange={(e) => setFullName(e.target.value)}
        className={inputClass}
      />
    </div>
  );

  const messages = (
    <>
      {error ? (
        <p role="alert" className="rounded bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </p>
      ) : null}
      {info ? (
        <p role="status" className="rounded bg-teal-50 px-3 py-2 text-sm text-teal-900">
          {info}
        </p>
      ) : null}
    </>
  );

  if (signedInEmail) {
    return (
      <form onSubmit={onRegister} className="space-y-4">
        <p className="text-sm text-slate-700">{t("join.signedInAs", { email: signedInEmail })}</p>
        {typeField}
        {nameField}
        {messages}
        <button type="submit" disabled={busy} className={`${buttonClass} w-full`}>
          {busy ? t("join.creating") : t("join.createProfile")}
        </button>
      </form>
    );
  }

  return (
    <div className="space-y-5">
      {googleEnabled ? (
        <>
          <button type="button" onClick={onGoogle} className={`${secondaryButtonClass} w-full`}>
            {t("join.google")}
          </button>
          <p className="text-center text-sm text-slate-500">{t("join.or")}</p>
        </>
      ) : null}
      <form onSubmit={onSignUp} className="space-y-4">
        {claimPath ? null : typeField}
        {nameField}
        <div>
          <label htmlFor="join-email" className={labelClass}>
            {t("join.email")}
          </label>
          <input
            id="join-email"
            type="email"
            required
            autoComplete="email"
            value={email}
            aria-invalid={invalid.includes("email")}
            onChange={(e) => setEmail(e.target.value)}
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor="join-password" className={labelClass}>
            {t("join.password")}
          </label>
          <input
            id="join-password"
            type="password"
            required
            minLength={8}
            maxLength={72}
            autoComplete="new-password"
            aria-describedby="join-password-hint"
            value={password}
            aria-invalid={invalid.includes("password")}
            onChange={(e) => setPassword(e.target.value)}
            className={inputClass}
          />
          <p id="join-password-hint" className="mt-1 text-xs text-slate-600">
            {t("join.passwordHint")}
          </p>
        </div>
        {messages}
        <button type="submit" disabled={busy} className={`${buttonClass} w-full`}>
          {busy ? t("join.submitting") : t("join.submit")}
        </button>
      </form>
      <p className="text-center text-sm text-slate-600">
        {t("join.haveAccount")}{" "}
        <Link
          href={`/login?next=${encodeURIComponent(claimPath ?? "/join")}`}
          className="font-medium text-slate-900 underline"
        >
          {t("join.signIn")}
        </Link>
      </p>
    </div>
  );
}
