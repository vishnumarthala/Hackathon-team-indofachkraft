"use client";

import Link from "next/link";
import { citationHref, MESSAGES_PATH, needsMessagesLink, type FollowupAnswer, type FollowupChannel } from "@/lib/followup/constants";
import { useFormatter, useT } from "@/lib/i18n/client";

export type ChatItem = FollowupAnswer & { id: string; question: string; channel: FollowupChannel; created_at: string };

// Ticket 040 FR-4: one question and its answer. Citation chips open the cited published document at the cited
// version; a red flag shows only the 108/112 message; not-found and medicine answers link to Messages.
export function AnswerCard({ item, childId }: { item: ChatItem; childId: string }) {
  const t = useT("followup");
  const format = useFormatter();
  const urgent = item.safety === "red_flag";
  return (
    <li className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4" data-testid="followup-answer" data-found={item.found} data-safety={item.safety ?? ""}>
      <div className="space-y-1">
        <p className="text-sm font-semibold text-slate-600">
          {t("you")}
          {item.channel === "voice" ? ` · ${t("byVoice")}` : ""} · <time dateTime={item.created_at}>{format.dateTime(item.created_at)}</time>
        </p>
        <p className="break-words text-slate-900" lang="en">
          {item.question}
        </p>
      </div>
      {urgent ? (
        <p role="alert" lang="en" data-testid="followup-urgent" className="rounded-xl border-2 border-red-600 bg-red-50 p-4 text-lg font-semibold leading-relaxed text-red-900">
          {item.answer}
        </p>
      ) : (
        <div className="space-y-2">
          <p className="text-sm font-semibold text-slate-600">{t("answer")}</p>
          <p className="break-words leading-relaxed text-slate-900" lang="en">
            {item.answer}
          </p>
        </div>
      )}
      {item.citations.length > 0 ? (
        <div className="space-y-2">
          <p className="text-sm font-semibold text-slate-600">{t("sources")}</p>
          <ul className="flex flex-wrap gap-2">
            {item.citations.map((c) => (
              <li key={`${c.entity_type}:${c.entity_id}:${c.version}`} className="max-w-full">
                <Link
                  href={citationHref(childId, c)}
                  aria-label={t("openSource", { label: c.label })}
                  data-testid="citation-chip"
                  data-entity-type={c.entity_type}
                  data-version={c.version}
                  className="inline-flex min-h-11 max-w-full flex-col rounded-xl border border-teal-300 bg-teal-50 px-3 py-2 text-left text-sm text-teal-900 hover:bg-teal-100 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-600/30"
                >
                  <span className="font-semibold break-words" lang="en">
                    {c.label}
                  </span>
                  {c.excerpt ? (
                    <span className="break-words text-teal-800" lang="en">
                      “{c.excerpt}”
                    </span>
                  ) : null}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {needsMessagesLink(item) ? (
        <Link href={MESSAGES_PATH} className="inline-flex min-h-11 items-center font-semibold text-teal-800 underline" data-testid="followup-messages-link">
          {t("messagesLink")}
        </Link>
      ) : null}
    </li>
  );
}
