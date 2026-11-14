"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { useT } from "@/lib/i18n/client";
import { assessmentErrorKey, type ApiErrorKey } from "./view";
import { Button } from "@/components/ui/Button";

// 024 FR-8: `Mark reviewed` with a note and `Share result with parent` (publishes the summary).
export function AssessmentReviewForm({ assessmentId }: { assessmentId: string }) {
  const t = useT("assessments.provider");
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiErrorKey | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/assessments/${assessmentId}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          note: String(data.get("note") ?? ""),
          share_with_parent: data.get("share_with_parent") === "on",
        }),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        setError(assessmentErrorKey(json.error));
      } else {
        router.refresh();
      }
    } catch {
      setError("saveFailed");
    }
    setBusy(false);
  }

  return (
    <form onSubmit={submit} className="space-y-3 rounded border border-slate-200 bg-white p-4" aria-labelledby="review-title">
      <h3 id="review-title" className="font-semibold">
        {t("reviewTitle")}
      </h3>
      <label className="block text-sm font-medium text-slate-800">
        {t("note")}
        <textarea name="note" rows={3} maxLength={2000} className="mt-1 block w-full rounded border border-slate-300 px-3 py-2 text-sm" />
      </label>
      <label className="flex min-h-11 items-start gap-2 text-sm text-slate-800">
        <input type="checkbox" name="share_with_parent" className="mt-1 h-4 w-4" />
        <span>
          <span className="font-medium">{t("share")}</span>
          <span className="block text-slate-600">{t("shareHint")}</span>
        </span>
      </label>
      {error ? (
        <p role="alert" className="text-sm font-medium text-red-700">
          {t(`errors.${error}`)}
        </p>
      ) : null}
      <Button type="submit" disabled={busy}>
        {busy ? t("reviewing") : t("markReviewed")}
      </Button>
    </form>
  );
}
