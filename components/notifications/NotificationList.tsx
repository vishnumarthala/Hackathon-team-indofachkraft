"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { secondaryButtonClass } from "@/components/family/PhoneOtpForm";
import { useFormatter, useT } from "@/lib/i18n/client";
import type { InboxItem } from "@/lib/notify/inbox";

/** FR-7 list with `Mark all as read` and `Load more` (cursor pagination over GET /api/notifications). */
export function NotificationList({
  initialItems,
  initialCursor,
  initialUnread,
}: {
  initialItems: InboxItem[];
  initialCursor: string | null;
  initialUnread: number;
}) {
  const t = useT("notifications");
  const format = useFormatter();
  const router = useRouter();
  const [items, setItems] = useState(initialItems);
  const [cursor, setCursor] = useState(initialCursor);
  const [unread, setUnread] = useState(initialUnread);
  const [busy, setBusy] = useState<"idle" | "marking" | "loading">("idle");
  const [error, setError] = useState<string | null>(null);

  async function markRead(body: { all: true } | { ids: string[] }) {
    const res = await fetch("/api/notifications/read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(String(res.status));
    return (await res.json()) as { unread: number };
  }

  async function markAll() {
    setBusy("marking");
    setError(null);
    try {
      const result = await markRead({ all: true });
      const now = new Date().toISOString();
      setItems((current) => current.map((item) => (item.read_at ? item : { ...item, read_at: now })));
      setUnread(result.unread);
      router.refresh();
    } catch {
      setError(t("markFailed"));
    } finally {
      setBusy("idle");
    }
  }

  async function loadMore() {
    if (!cursor) return;
    setBusy("loading");
    setError(null);
    try {
      const res = await fetch(`/api/notifications?cursor=${encodeURIComponent(cursor)}`);
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as { items: InboxItem[]; next_cursor: string | null; unread: number };
      setItems((current) => [...current, ...data.items]);
      setCursor(data.next_cursor);
      setUnread(data.unread);
    } catch {
      setError(t("loadFailed"));
    } finally {
      setBusy("idle");
    }
  }

  function opened(item: InboxItem) {
    if (item.read_at) return;
    // Best effort; the target page loads regardless.
    void markRead({ ids: [item.id] }).catch(() => {});
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p role="status" className="text-sm text-slate-700" data-testid="unread-count">
          {t("bellLabel", { count: unread })}
        </p>
        <button type="button" className={secondaryButtonClass} onClick={markAll} disabled={busy !== "idle" || unread === 0}>
          {busy === "marking" ? t("marking") : t("markAllRead")}
        </button>
      </div>
      {error ? (
        <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
          {error}
        </p>
      ) : null}
      {items.length === 0 ? (
        <p className="rounded-xl border border-slate-200 bg-white p-4 text-slate-700">{t("empty")}</p>
      ) : (
        <ul className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white" data-testid="notification-list">
          {items.map((item) => (
            <li key={item.id} className={`flex flex-col gap-1 p-4 ${item.read_at ? "" : "bg-teal-50/60"}`}>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <p className="font-semibold text-slate-900">
                  {item.read_at ? null : <span className="sr-only">{t("unread")}: </span>}
                  {item.title}
                </p>
                <time dateTime={item.created_at} className="text-sm text-slate-600">
                  {format.dateTime(item.created_at)}
                </time>
              </div>
              <p className="text-slate-700">{item.body}</p>
              {item.link ? (
                <Link
                  href={item.link}
                  onClick={() => opened(item)}
                  className="mt-1 inline-flex min-h-11 w-fit items-center text-sm font-semibold text-teal-800 underline"
                >
                  {t("open")}
                  <span className="sr-only">: {item.title}</span>
                </Link>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {cursor ? (
        <button type="button" className={secondaryButtonClass} onClick={loadMore} disabled={busy !== "idle"}>
          {busy === "loading" ? t("loading") : t("loadMore")}
        </button>
      ) : null}
    </div>
  );
}
