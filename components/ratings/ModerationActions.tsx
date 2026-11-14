"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { inputClass, labelClass, secondaryButtonClass, send } from "@/components/providers/request";
import { useT } from "@/lib/i18n/client";
import type { RatingStatus } from "@/lib/ratings/rules";
import { Button } from "@/components/ui/Button";

/** 036 FR-6 admin `Publish` / `Hide` with a note (required to hide). */
export function ModerationActions({ ratingId, status }: { ratingId: string; status: RatingStatus }) {
  const t = useT("ratings.admin");
  const router = useRouter();
  const id = useId();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<"noteRequired" | "failed" | null>(null);

  async function act(action: "publish" | "hide") {
    if (action === "hide" && note.trim().length < 3) return setError("noteRequired");
    setBusy(true);
    setError(null);
    const res = await send(`/api/admin/ratings/${ratingId}`, "POST", { action, ...(note.trim() ? { note: note.trim() } : {}) });
    setBusy(false);
    if (!res.ok) return setError(res.status === 400 && action === "hide" ? "noteRequired" : "failed");
    setNote("");
    router.refresh();
  }

  return (
    <div className="space-y-2">
      <label htmlFor={`${id}-note`} className={labelClass}>
        {t("note")}
      </label>
      <textarea
        id={`${id}-note`}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        maxLength={500}
        rows={2}
        aria-invalid={error === "noteRequired"}
        className={inputClass}
      />
      {error ? (
        <p role="alert" className="text-sm text-red-800">
          {t(error)}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {status !== "published" ? (
          <Button type="button" disabled={busy} onClick={() => act("publish")}>
            {t("publish")}
          </Button>
        ) : null}
        {status !== "hidden" ? (
          <button type="button" disabled={busy} onClick={() => act("hide")} className={secondaryButtonClass}>
            {t("hide")}
          </button>
        ) : null}
      </div>
    </div>
  );
}
