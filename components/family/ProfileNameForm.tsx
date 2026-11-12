"use client";

import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { inputClass, primaryButtonClass } from "@/components/family/PhoneOtpForm";
import { useT } from "@/lib/i18n/client";

/** FR-8: `Your name` (1-80 characters) saved with PATCH /api/family/profile. */
export function ProfileNameForm({ initialName }: { initialName: string }) {
  const t = useT("family.settings");
  const tErrors = useT("errors");
  const router = useRouter();
  const id = useId();
  const [name, setName] = useState(initialName);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "invalid" | "failed">("idle");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed.length < 1 || trimmed.length > 80) {
      setStatus("invalid");
      return;
    }
    setStatus("saving");
    try {
      const res = await fetch("/api/family/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ display_name: trimmed }),
      });
      if (res.status === 400) {
        setStatus("invalid");
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      setStatus("saved");
      router.refresh();
    } catch {
      setStatus("failed");
    }
  }

  const error = status === "invalid" ? t("nameInvalid") : status === "failed" ? tErrors("generic") : "";
  return (
    <form className="space-y-3" onSubmit={submit} noValidate>
      <label htmlFor={`${id}-name`} className="block text-sm font-semibold text-slate-900">
        {t("name")}
      </label>
      <input
        id={`${id}-name`}
        autoComplete="name"
        maxLength={80}
        className={inputClass}
        value={name}
        aria-invalid={error ? true : undefined}
        aria-describedby={`${id}-hint${error ? ` ${id}-error` : ""}`}
        onChange={(event) => {
          setName(event.target.value);
          if (status !== "saving") setStatus("idle");
        }}
      />
      <p id={`${id}-hint`} className="text-sm text-slate-600">
        {t("nameHint")}
      </p>
      {error ? (
        <p id={`${id}-error`} role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
          {error}
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
