"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { buttonClass, inputClass, labelClass, send } from "@/components/providers/request";
import { useT } from "@/lib/i18n/client";

type ErrorKey = "screen" | "notEligible" | "already" | "locked" | "chooseStars" | "generic";

function errorFor(status: number): ErrorKey {
  if (status === 422) return "screen";
  if (status === 403) return "notEligible";
  if (status === 409) return "already";
  return "generic";
}

/** 036 FR-3: 1-5 stars (radio group) + optional comment (<= 500). POST to rate, PATCH to change within 7 days. */
export function RatingForm({
  appointmentId,
  mode,
  initialStars,
  initialComment = "",
}: {
  appointmentId: string;
  mode: "create" | "edit";
  initialStars?: number;
  initialComment?: string;
}) {
  const t = useT("ratings.form");
  const router = useRouter();
  const [stars, setStars] = useState<number | null>(initialStars ?? null);
  const [comment, setComment] = useState(initialComment);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorKey | null>(null);
  const [saved, setSaved] = useState<"published" | "pending_review" | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!stars) return setError("chooseStars");
    setBusy(true);
    setError(null);
    const res = await send(`/api/appointments/${appointmentId}/rating`, mode === "create" ? "POST" : "PATCH", {
      stars,
      comment: comment.trim() ? comment.trim() : null,
    });
    setBusy(false);
    if (!res.ok) {
      setError(mode === "edit" && res.status === 409 ? "locked" : errorFor(res.status));
      return;
    }
    const status = (res.json.rating as { status?: string } | undefined)?.status;
    setSaved(status === "pending_review" ? "pending_review" : "published");
    router.refresh();
  }

  if (saved) {
    return (
      <div role="status" className="space-y-3 rounded border border-teal-200 bg-teal-50 p-4 text-teal-900">
        <p>{saved === "pending_review" ? t("savedReview") : t("saved")}</p>
        <Link href="/family/appointments" className="inline-flex min-h-11 items-center font-semibold underline">
          {t("back")}
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-5 rounded-2xl border border-slate-200 bg-white p-4" noValidate>
      <fieldset aria-describedby={error === "chooseStars" ? "rating-error" : undefined}>
        <legend className="text-base font-semibold text-slate-900">{t("starsLegend")}</legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {[1, 2, 3, 4, 5].map((n) => (
            <label
              key={n}
              className={`inline-flex min-h-11 min-w-11 cursor-pointer items-center justify-center gap-1 rounded border px-3 text-lg has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-teal-700 ${
                stars !== null && n <= stars ? "border-amber-400 bg-amber-50 text-amber-700" : "border-slate-300 bg-white text-slate-400"
              }`}
            >
              <input
                type="radio"
                name="stars"
                value={n}
                checked={stars === n}
                onChange={() => setStars(n)}
                className="sr-only"
                aria-label={t("star", { count: n })}
              />
              <span aria-hidden="true">★</span>
              <span aria-hidden="true" className="text-sm text-slate-700">
                {n}
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <div>
        <label htmlFor="rating-comment" className={labelClass}>
          {t("commentLabel")}
        </label>
        <textarea
          id="rating-comment"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          maxLength={500}
          rows={4}
          aria-describedby="rating-comment-hint rating-comment-count"
          aria-invalid={error === "screen"}
          className={inputClass}
        />
        <p id="rating-comment-hint" className="mt-1 text-sm text-slate-600">
          {t("commentHint")}
        </p>
        <p id="rating-comment-count" className="text-xs text-slate-500">
          {t("counter", { count: comment.length })}
        </p>
      </div>
      {error ? (
        <p id="rating-error" role="alert" className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          {t(`errors.${error}`)}
        </p>
      ) : null}
      <button type="submit" disabled={busy} className={buttonClass}>
        {busy ? t("saving") : mode === "create" ? t("submit") : t("update")}
      </button>
    </form>
  );
}
