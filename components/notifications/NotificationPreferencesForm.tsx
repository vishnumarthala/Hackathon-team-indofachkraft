"use client";

import { useId, useState, type FormEvent } from "react";
import { primaryButtonClass } from "@/components/family/PhoneOtpForm";
import { useT } from "@/lib/i18n/client";

type Preferences = { email: boolean; whatsapp: boolean };

/** FR-8 `Email` and `WhatsApp` switches (PUT /api/notification-preferences). In-app is always on. */
export function NotificationPreferencesForm({ initial }: { initial: Preferences }) {
  const t = useT("notifications.prefs");
  const id = useId();
  const [prefs, setPrefs] = useState(initial);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "failed">("idle");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("saving");
    try {
      const res = await fetch("/api/notification-preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(prefs),
      });
      if (!res.ok) throw new Error(String(res.status));
      setPrefs(((await res.json()) as { preferences: Preferences }).preferences);
      setStatus("saved");
    } catch {
      setStatus("failed");
    }
  }

  const toggle = (channel: keyof Preferences) => (event: { target: { checked: boolean } }) => {
    setPrefs((current) => ({ ...current, [channel]: event.target.checked }));
    setStatus("idle");
  };

  return (
    <form className="space-y-4" onSubmit={submit} noValidate>
      <p className="text-sm text-slate-700">{t("intro")}</p>
      {(["email", "whatsapp"] as const).map((channel) => (
        <div key={channel} className="flex items-start gap-3">
          <input
            id={`${id}-${channel}`}
            type="checkbox"
            role="switch"
            className="mt-1 h-6 w-6 shrink-0 accent-teal-700"
            checked={prefs[channel]}
            onChange={toggle(channel)}
            aria-describedby={`${id}-${channel}-hint`}
          />
          <div>
            <label htmlFor={`${id}-${channel}`} className="block font-semibold text-slate-900">
              {t(channel)}
            </label>
            <p id={`${id}-${channel}-hint`} className="text-sm text-slate-600">
              {t(channel === "email" ? "emailHint" : "whatsappHint")}
            </p>
          </div>
        </div>
      ))}
      {status === "failed" ? (
        <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
          {t("failed")}
        </p>
      ) : null}
      {status === "saved" ? (
        <p role="status" className="text-sm font-medium text-teal-800">
          {t("saved")}
        </p>
      ) : null}
      <button type="submit" className={`${primaryButtonClass} sm:w-auto`} disabled={status === "saving"}>
        {status === "saving" ? t("saving") : t("save")}
      </button>
    </form>
  );
}
