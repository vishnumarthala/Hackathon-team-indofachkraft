"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n/client";
import { messagesSubscription } from "./realtime";
import { startThreadSync, type SyncStatus } from "./threadSync";

type Listed = { id: string; last_message_at: string; unread: number; archived_at: string | null };

// 027 FR-5 for inbox pages: new conversations and messages appear without reload. Realtime (any new message the
// user may read, RLS-filtered) or polling every 15 s fetch `endpoint`; when the list changed the server-rendered
// page is refreshed. A 404 (e.g. the case was taken away) shows the access message.
export function LiveThreadsRefresher({ endpoint }: { endpoint: string }) {
  const t = useT("messaging");
  const router = useRouter();
  const [status, setStatus] = useState<SyncStatus>("connecting");
  const signature = useRef<string | null>(null);

  useEffect(() => {
    const sync = startThreadSync({
      subscribe: messagesSubscription({ events: "INSERT" }),
      onStatus: setStatus,
      refresh: async () => {
        const res = await fetch(endpoint, { cache: "no-store" });
        if (res.status === 404 || res.status === 401) return "lost";
        if (!res.ok) return "error";
        const { threads } = (await res.json()) as { threads: Listed[] };
        const next = threads.map((x) => `${x.id}:${x.last_message_at}:${x.unread}:${x.archived_at ?? ""}`).join("|");
        if (signature.current !== null && signature.current !== next) router.refresh();
        signature.current = next;
        return "ok";
      },
    });
    void sync.refreshNow();
    return () => sync.stop();
  }, [endpoint, router]);

  if (status === "lost") {
    return (
      <p role="alert" className="rounded-xl border border-amber-300 bg-amber-50 p-4 font-medium text-amber-900" data-testid="access-lost">
        {t("accessLost")}
      </p>
    );
  }
  return (
    <p className="text-xs text-slate-600" role="status" data-sync-status={status}>
      {status === "live" ? t("statusLive") : status === "polling" ? t("statusPolling") : t("statusConnecting")}
    </p>
  );
}
