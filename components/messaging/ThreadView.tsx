"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { buttonClasses, type Tone } from "@/components/documents/styles";
import { useFormatter, useT } from "@/lib/i18n/client";
import { BODY_MAX } from "@/lib/messaging/constants";
import type { MessageView } from "@/lib/messaging/types";
import { messagesSubscription } from "./realtime";
import { startThreadSync, type SyncStatus } from "./threadSync";
import { EmergencyBanner } from "./EmergencyBanner";
import { messagingErrorKey, mergeMessages, newClientId, type MessagingErrorKey } from "./client";
import { Badge } from "@/components/ui/Badge";

export type ThreadViewProps = {
  thread: { id: string; subject: string; archivedAt: string | null; orgName: string; childName: string };
  initial: { messages: MessageView[]; has_more: boolean };
  documents: { id: string; title: string; attachable: boolean }[];
  canArchive: boolean;
  tone: Tone;
  backHref: string;
};

const POINTER_QUERY = "(pointer: coarse)";
function subscribePointer(onChange: () => void) {
  const mq = window.matchMedia?.(POINTER_QUERY);
  mq?.addEventListener?.("change", onChange);
  return () => mq?.removeEventListener?.("change", onChange);
}
/** Touch screens: Enter adds a new line and the button sends (FR-4). */
function coarsePointer() {
  return window.matchMedia?.(POINTER_QUERY).matches ?? false;
}

/** `Parent` or the provider's discipline (care-team label, else their 028 profession), else `Care team`. */
function useRoleLabel() {
  const t = useT("messaging");
  const tp = useT("providers.types");
  return (m: MessageView) => {
    if (m.sender_kind === "guardian") return t("parent");
    if (m.discipline_label) return m.discipline_label;
    if (m.provider_type) return tp(m.provider_type);
    return t("careTeam");
  };
}

function MessageItem({ message, onDelete, tone }: { message: MessageView; onDelete: (id: string) => void; tone: Tone }) {
  const t = useT("messaging");
  const format = useFormatter();
  const roleLabel = useRoleLabel();
  const classes = buttonClasses(tone);
  const name = message.own ? t("you") : (message.sender_name ?? roleLabel(message));
  const showRole = message.own || message.sender_name !== null;
  return (
    <li
      className={`max-w-[92%] space-y-1 rounded-2xl border px-4 py-3 sm:max-w-[80%] ${
        message.own ? "ml-auto border-teal-200 bg-teal-50" : "mr-auto border-slate-200 bg-white"
      }`}
      data-message={message.id}
    >
      <p className="text-sm text-slate-700">
        <span className="font-semibold text-slate-900">{name}</span>
        {showRole ? <span> · {roleLabel(message)}</span> : null}
        <span className="text-slate-600">
          {" · "}
          <time dateTime={message.created_at}>{format.dateTime(message.created_at)}</time>
        </span>
      </p>
      <p className={`break-words whitespace-pre-wrap ${message.deleted ? "text-slate-600 italic" : "text-slate-900"}`}>
        {message.deleted ? t("deleted") : message.body}
      </p>
      {message.document ? (
        message.document.available ? (
          <a
            href={message.document.url}
            className="inline-flex min-h-11 items-center text-sm font-semibold text-teal-800 underline"
            aria-label={t("openDocument", { title: message.document.title })}
          >
            {message.document.title}
          </a>
        ) : (
          <p className="text-sm text-slate-600">{t("attachmentUnavailable")}</p>
        )
      ) : null}
      {message.can_delete ? (
        <button type="button" className={`${classes.secondary} text-xs`} onClick={() => onDelete(message.id)}>
          {t("delete")}
        </button>
      ) : null}
    </li>
  );
}

// 027 FR-4/FR-5: one conversation. Messages oldest -> newest, composer (Enter sends on desktop, the button on
// touch screens), document picker, live updates (Realtime, else polling every 15 s) and the read marker.
export function ThreadView({ thread, initial, documents, canArchive, tone, backHref }: ThreadViewProps) {
  const t = useT("messaging");
  const classes = buttonClasses(tone);
  const ids = { body: useId(), doc: useId(), hint: useId(), error: useId() };
  const [messages, setMessages] = useState<MessageView[]>(initial.messages);
  const [hasMore, setHasMore] = useState(initial.has_more);
  const [archivedAt, setArchivedAt] = useState(thread.archivedAt);
  const [status, setStatus] = useState<SyncStatus>("connecting");
  const [body, setBody] = useState("");
  const [documentId, setDocumentId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MessagingErrorKey | null>(null);
  const clientId = useRef<string>(newClientId());
  const listEnd = useRef<HTMLDivElement>(null);
  const coarse = useSyncExternalStore(subscribePointer, coarsePointer, () => false);
  const lost = status === "lost";
  const readOnly = lost || archivedAt !== null;

  const markRead = useCallback(() => {
    if (document.visibilityState !== "visible") return;
    void fetch(`/api/threads/${thread.id}/read`, { method: "POST" }).catch(() => {});
  }, [thread.id]);

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/threads/${thread.id}/messages`, { cache: "no-store" });
    if (res.status === 404 || res.status === 401) return "lost" as const;
    if (!res.ok) return "error" as const;
    const page = (await res.json()) as { messages: MessageView[] };
    setMessages((current) => mergeMessages(current, page.messages));
    return "ok" as const;
  }, [thread.id]);

  useEffect(() => {
    const sync = startThreadSync({
      refresh,
      subscribe: messagesSubscription({ threadId: thread.id }),
      onStatus: setStatus,
    });
    const onVisible = () => {
      if (document.visibilityState === "visible") void sync.refreshNow().then(markRead);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      sync.stop();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh, markRead, thread.id]);

  const newest = messages.at(-1)?.id;
  useEffect(() => {
    if (lost) return;
    markRead();
    listEnd.current?.scrollIntoView?.({ block: "end" });
  }, [newest, lost, markRead]);

  async function loadOlder() {
    const oldest = messages[0]?.created_at;
    if (!oldest) return;
    const res = await fetch(`/api/threads/${thread.id}/messages?before=${encodeURIComponent(oldest)}`, { cache: "no-store" });
    if (res.status === 404) return setStatus("lost");
    if (!res.ok) return;
    const page = (await res.json()) as { messages: MessageView[]; has_more: boolean };
    setMessages((current) => mergeMessages(current, page.messages));
    setHasMore(page.has_more);
  }

  async function send() {
    if (busy || readOnly) return;
    if (!body.trim()) return setError("bodyRequired");
    if (body.length > BODY_MAX) return setError("tooLong");
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/threads/${thread.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body, client_id: clientId.current, document_id: documentId || null }),
      });
      if (res.status === 404) return setStatus("lost");
      if (!res.ok) {
        const key = messagingErrorKey(res.status, ((await res.json().catch(() => ({}))) as { error?: string }).error);
        if (key === "archived") setArchivedAt(new Date().toISOString());
        return setError(key);
      }
      const { message } = (await res.json()) as { message: MessageView };
      setMessages((current) => mergeMessages(current, [message]));
      setBody("");
      setDocumentId("");
      clientId.current = newClientId();
    } catch {
      setError("failed");
    } finally {
      setBusy(false);
    }
  }

  async function remove(messageId: string) {
    if (!window.confirm(t("deleteConfirm"))) return;
    setError(null);
    const res = await fetch(`/api/messages/${messageId}`, { method: "DELETE" }).catch(() => null);
    if (!res) return setError("failed");
    if (res.status === 404) return setStatus("lost");
    if (!res.ok) return setError(messagingErrorKey(res.status, ((await res.json().catch(() => ({}))) as { error?: string }).error));
    const { message } = (await res.json()) as { message: MessageView };
    setMessages((current) => mergeMessages(current, [message]));
  }

  async function archive() {
    if (!window.confirm(t("archiveConfirm"))) return;
    const res = await fetch(`/api/threads/${thread.id}/archive`, { method: "POST" }).catch(() => null);
    if (!res) return setError("failed");
    if (res.status === 404) return setStatus("lost");
    if (!res.ok) return setError(messagingErrorKey(res.status));
    setArchivedAt(new Date().toISOString());
  }

  const statusText = useMemo(
    () => ({ connecting: t("statusConnecting"), live: t("statusLive"), polling: t("statusPolling"), lost: "" })[status],
    [status, t],
  );

  return (
    <div className="space-y-4">
      <Link href={backHref} className="inline-flex min-h-11 items-center text-sm font-semibold text-teal-800 underline">
        {tone === "family" ? t("backFamily") : t("backProvider")}
      </Link>
      <EmergencyBanner />
      <header className="space-y-1">
        <h1 className="text-2xl font-bold break-words text-slate-900">{thread.subject}</h1>
        <p className="text-sm text-slate-600">
          {tone === "family" ? t("with", { org: thread.orgName }) : t("about", { name: thread.childName })}
          {archivedAt ? <Badge className="ml-2">{t("archived")}</Badge> : null}
        </p>
        <p className="text-xs text-slate-600" role="status" data-sync-status={status}>
          {statusText}
        </p>
      </header>

      {lost ? (
        <p role="alert" className="rounded-xl border border-amber-300 bg-amber-50 p-4 font-medium text-amber-900" data-testid="access-lost">
          {t("accessLost")}
        </p>
      ) : (
        <>
          {hasMore ? (
            <button type="button" className={classes.secondary} onClick={() => void loadOlder()}>
              {t("older")}
            </button>
          ) : null}
          {messages.length === 0 ? <p className="text-slate-600">{t("noThreads")}</p> : null}
          <ol aria-label={t("messagesLabel")} aria-live="polite" className="flex flex-col gap-3">
            {messages.map((m) => (
              <MessageItem key={m.id} message={m} onDelete={(id) => void remove(id)} tone={tone} />
            ))}
          </ol>
          <div ref={listEnd} />
        </>
      )}

      {archivedAt && !lost ? <p className="rounded-xl bg-slate-100 p-3 text-sm text-slate-700">{t("archivedNotice")}</p> : null}

      {!readOnly ? (
        <form
          className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <div className="space-y-1">
            <label htmlFor={ids.body} className="block text-sm font-medium text-slate-900">
              {t("body")}
            </label>
            <textarea
              id={ids.body}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !coarse && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send();
                }
              }}
              rows={3}
              maxLength={BODY_MAX}
              aria-describedby={`${coarse ? "" : ids.hint} ${error ? ids.error : ""}`.trim() || undefined}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-base"
            />
            <p id={ids.hint} className="text-xs text-slate-600 pointer-coarse:hidden">
              {t("sendHint")}
            </p>
          </div>
          {documents.length > 0 ? (
            <div className="space-y-1">
              <label htmlFor={ids.doc} className="block text-sm font-medium text-slate-900">
                {t("attach")}
              </label>
              <select
                id={ids.doc}
                value={documentId}
                onChange={(e) => setDocumentId(e.target.value)}
                className="min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-base sm:w-auto"
              >
                <option value="">{t("noAttachment")}</option>
                {documents.map((d) => (
                  <option key={d.id} value={d.id} disabled={!d.attachable}>
                    {d.attachable ? d.title : t("notVisibleToAll", { title: d.title })}
                  </option>
                ))}
              </select>
              <p className="text-xs text-slate-600">{t("attachHint")}</p>
            </div>
          ) : null}
          {error ? (
            <p id={ids.error} role="alert" className="text-sm font-medium text-red-700">
              {t(`errors.${error}`)}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            <button type="submit" className={classes.primary} disabled={busy}>
              {busy ? t("sending") : t("send")}
            </button>
            {canArchive ? (
              <button type="button" className={classes.secondary} onClick={() => void archive()}>
                {t("archive")}
              </button>
            ) : null}
          </div>
        </form>
      ) : null}
    </div>
  );
}
