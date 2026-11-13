"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useT } from "@/lib/i18n/client";

/** FR-9 admin `Retry` for a dead notification. */
export function RetryButton({ id }: { id: string }) {
  const t = useT("notifications.admin");
  const router = useRouter();
  const [state, setState] = useState<"idle" | "busy" | "done" | "failed">("idle");

  async function retry() {
    setState("busy");
    try {
      const res = await fetch(`/api/admin/notifications/${id}/retry`, { method: "POST" });
      if (!res.ok) throw new Error(String(res.status));
      setState("done");
      router.refresh();
    } catch {
      setState("failed");
    }
  }

  if (state === "done") return <span role="status" className="text-sm text-teal-800">{t("retried")}</span>;
  return (
    <span className="inline-flex flex-col gap-1">
      <button
        type="button"
        onClick={retry}
        disabled={state === "busy"}
        className="min-h-11 rounded border border-slate-300 px-3 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-60"
      >
        {state === "busy" ? t("retrying") : t("retry")}
      </button>
      {state === "failed" ? <span role="alert" className="text-sm text-red-700">{t("retryFailed")}</span> : null}
    </span>
  );
}
