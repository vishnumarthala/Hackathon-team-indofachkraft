"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { inputClass, labelClass, secondaryButtonClass, send } from "@/components/providers/request";
import { useT } from "@/lib/i18n/client";
import { Button } from "@/components/ui/Button";

/** 037 FR-4: provider pastes a Google Meet link when the automatic one failed (or changes an earlier manual one). */
export function AddVideoLinkForm({ appointmentId, change = false }: { appointmentId: string; change?: boolean }) {
  const t = useT("booking.meet");
  const router = useRouter();
  const id = useId();
  const [open, setOpen] = useState(!change);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<"invalidLink" | "saveFailed" | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await send(`/api/appointments/${appointmentId}/meet-link`, "POST", { url });
    setBusy(false);
    if (res.ok) {
      setUrl("");
      if (change) setOpen(false);
      router.refresh();
      return;
    }
    setError(res.status === 400 ? "invalidLink" : "saveFailed");
  }

  if (!open) {
    return (
      <button type="button" className={secondaryButtonClass} onClick={() => setOpen(true)}>
        {t("changeLink")}
      </button>
    );
  }
  return (
    <form onSubmit={save} className="w-full space-y-2" noValidate>
      <label htmlFor={`${id}-url`} className={labelClass}>
        {t("linkLabel")}
      </label>
      <input
        id={`${id}-url`}
        type="url"
        inputMode="url"
        autoComplete="off"
        required
        placeholder="https://meet.google.com/abc-defg-hij"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        aria-invalid={error === "invalidLink"}
        aria-describedby={error ? `${id}-error` : undefined}
        className={inputClass}
      />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy || !url.trim()}>
          {busy ? t("saving") : change ? t("save") : t("addLink")}
        </Button>
        {change ? (
          <button type="button" className={secondaryButtonClass} disabled={busy} onClick={() => setOpen(false)}>
            {t("cancel")}
          </button>
        ) : null}
      </div>
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-sm text-red-800">
          {t(error)}
        </p>
      ) : null}
    </form>
  );
}
