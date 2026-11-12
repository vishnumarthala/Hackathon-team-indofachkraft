"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { LOCALE_LABELS, LOCALES, isLocale, type Locale } from "@/lib/i18n/config";
import { useLocale, useT } from "@/lib/i18n/client";

type Props = {
  /** Show the "Language" label visibly (it is always the accessible name). */
  showLabel?: boolean;
  className?: string;
  selectClassName?: string;
};

/** FR-7: UI language switcher. Saves the choice (cookie + profile) and re-renders the current route. */
export function LanguageSwitcher({ showLabel = false, className = "", selectClassName = "" }: Props) {
  const t = useT("language");
  const locale = useLocale();
  const router = useRouter();
  const id = useId();
  // The choice shows immediately; after the refresh the server-rendered locale matches it.
  const [selected, setSelected] = useState<Locale | null>(null);
  const [error, setError] = useState(false);
  const [pending, startTransition] = useTransition();
  const value = selected ?? locale;

  async function onChange(next: string) {
    if (!isLocale(next) || next === locale) return;
    setSelected(next);
    setError(false);
    try {
      const res = await fetch("/api/locale", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locale: next }),
      });
      if (!res.ok) throw new Error(String(res.status));
      startTransition(() => router.refresh());
    } catch {
      setSelected(null);
      setError(true);
    }
  }

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <label htmlFor={id} className={showLabel ? "text-sm font-medium" : "sr-only"}>
        {t("label")}
      </label>
      {!showLabel && (
        <svg viewBox="0 0 20 20" className="h-4 w-4 shrink-0 opacity-70" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
          <circle cx="10" cy="10" r="7.5" />
          <path d="M2.5 10h15M10 2.5c2 2.2 3 4.7 3 7.5s-1 5.3-3 7.5c-2-2.2-3-4.7-3-7.5s1-5.3 3-7.5Z" />
        </svg>
      )}
      <select
        id={id}
        value={value}
        disabled={pending}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={(e) => void onChange(e.target.value)}
        className={`min-h-9 cursor-pointer rounded-lg border border-current/20 bg-transparent px-2 py-1 text-sm font-medium disabled:cursor-wait disabled:opacity-60 ${selectClassName}`}
      >
        {LOCALES.map((l) => (
          <option key={l} value={l} lang={l} className="text-slate-900">
            {LOCALE_LABELS[l]}
          </option>
        ))}
      </select>
      {error && (
        <span id={`${id}-error`} role="alert" className="text-xs font-medium text-red-700">
          {t("changeFailed")}
        </span>
      )}
    </div>
  );
}
