import Link from "next/link";
import { getFormatter, getT } from "@/lib/i18n/server";
import type { ThreadListItem } from "@/lib/messaging/types";

// 027 FR-4: a list of conversations (server component). `show` picks the context line: the organisation for
// guardians, the child for providers.
export async function ThreadList({
  threads,
  hrefBase,
  show,
  label,
}: {
  threads: ThreadListItem[];
  hrefBase: string;
  show: "org" | "child";
  label: string;
}) {
  const [t, format] = await Promise.all([getT("messaging"), getFormatter()]);
  if (threads.length === 0) return <p className="text-slate-600">{t("noThreads")}</p>;
  return (
    <ul aria-label={label} className="divide-y divide-slate-200 overflow-hidden rounded-2xl border border-slate-200 bg-white">
      {threads.map((thread) => (
        <li key={thread.id} data-thread={thread.id}>
          <Link
            href={`${hrefBase}/${thread.id}`}
            className="flex min-h-11 flex-wrap items-start justify-between gap-2 px-4 py-3 hover:bg-slate-50"
            aria-label={t("openThread", { subject: thread.subject })}
          >
            <span className="min-w-0 space-y-0.5">
              <span className={`block break-words ${thread.unread > 0 ? "font-bold" : "font-semibold"} text-slate-900`}>{thread.subject}</span>
              <span className="block text-sm text-slate-600">
                {show === "org" ? t("with", { org: thread.org_name }) : t("about", { name: thread.case_label || thread.child_name })}
                {show === "child" ? ` · ${thread.org_name}` : ""} · {t("lastMessage", { time: format.dateTime(thread.last_message_at) })}
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-2">
              {thread.archived_at ? (
                <span className="rounded bg-slate-200 px-2 py-0.5 text-xs font-semibold text-slate-800">{t("archived")}</span>
              ) : null}
              {thread.unread > 0 ? (
                <span className="rounded-full bg-teal-700 px-2 py-0.5 text-xs font-semibold text-white" data-unread={thread.unread}>
                  {t("unread", { count: thread.unread })}
                </span>
              ) : null}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
