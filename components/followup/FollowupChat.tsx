"use client";

import { useState } from "react";
import { primaryButton } from "@/components/screen/view";
import { SUGGESTED_QUESTIONS } from "@/lib/followup/constants";
import { useT } from "@/lib/i18n/client";
import type { Locale } from "@/lib/i18n/config";
import { AnswerCard, type ChatItem } from "./AnswerCard";
import { FollowupVoice } from "./FollowupVoice";

type Props = {
  childId: string;
  childName: string;
  /** Newest first. */
  history: ChatItem[];
  remaining: number;
  /** 049: `languages` = languages enabled on the follow-up agent (ELEVENLABS_FOLLOWUP_LANGUAGES). */
  voice: { available: boolean; demo: boolean; languages?: Locale[] };
};

type AskError = "generic" | "limit" | "consent" | "length";

// Ticket 040 FR-4: the text chat (always available; also the fallback when voice is not). Answers are newest first.
export function FollowupChat({ childId, childName, history, remaining: initialRemaining, voice }: Props) {
  const t = useT("followup");
  const [items, setItems] = useState<ChatItem[]>(history);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AskError | null>(null);
  const [remaining, setRemaining] = useState(initialRemaining);

  const add = (item: ChatItem, counted: boolean) => {
    setItems((prev) => [item, ...prev]);
    if (counted) setRemaining((n) => Math.max(0, n - 1));
  };

  // After a live voice call: the agent's questions were stored by the server tool; reload the history.
  async function refresh() {
    const res = await fetch(`/api/family/children/${childId}/ask`, { cache: "no-store" }).catch(() => null);
    const json = (await res?.json().catch(() => null)) as { questions?: ChatItem[]; remaining_today?: number } | null;
    if (!res?.ok || !json?.questions) return;
    setItems(json.questions);
    if (typeof json.remaining_today === "number") setRemaining(json.remaining_today);
  }

  async function ask(text: string) {
    const q = text.trim();
    if (q.length < 3 || q.length > 500) {
      setError("length");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/family/children/${childId}/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q }),
      });
      const json = (await res.json().catch(() => null)) as (ChatItem & { error?: string }) | null;
      if (res.ok && json) {
        add({ ...json, id: json.id ?? `rf-${Date.now()}`, question: q, channel: "text", created_at: new Date().toISOString() }, json.safety !== "red_flag");
        setQuestion("");
      } else {
        setError(res.status === 429 ? "limit" : res.status === 422 ? "consent" : res.status === 400 ? "length" : "generic");
      }
    } catch {
      setError("generic");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <p className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-amber-950" data-testid="followup-disclaimer">
        {t("disclaimer")}
      </p>

      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void ask(question);
        }}
      >
        <label htmlFor="followup-question" className="block font-semibold text-slate-900">
          {t("inputLabel", { name: childName })}
        </label>
        <textarea
          id="followup-question"
          name="question"
          rows={3}
          maxLength={500}
          lang="en"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder={t("placeholder")}
          aria-describedby="followup-remaining"
          className="block w-full rounded-xl border border-slate-300 bg-white p-3 text-base text-slate-900 focus:border-teal-600 focus:outline-none focus:ring-4 focus:ring-teal-600/20"
        />
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <button type="submit" className={primaryButton} disabled={busy || remaining === 0}>
            {busy ? t("asking") : t("ask")}
          </button>
          <p id="followup-remaining" className="text-sm text-slate-600">
            {t("remaining", { count: remaining })}
          </p>
        </div>
        {error ? (
          <p role="alert" className="text-red-800" data-testid="followup-error">
            {t(`errors.${error}`)}
          </p>
        ) : null}
      </form>

      <section aria-labelledby="followup-suggestions" className="space-y-2">
        <h2 id="followup-suggestions" className="font-semibold text-slate-900">
          {t("suggestionsTitle")}
        </h2>
        <ul className="flex flex-wrap gap-2">
          {SUGGESTED_QUESTIONS.map((s) => (
            <li key={s}>
              <button
                type="button"
                lang="en"
                disabled={busy || remaining === 0}
                onClick={() => {
                  setQuestion(s);
                  void ask(s);
                }}
                className="min-h-11 rounded-full border border-teal-300 bg-white px-4 py-2 text-sm font-medium text-teal-900 hover:bg-teal-50 disabled:opacity-50"
              >
                {s}
              </button>
            </li>
          ))}
        </ul>
      </section>

      {voice.available ? <FollowupVoice childId={childId} demo={voice.demo} voiceLanguages={voice.languages} onAnswer={(item) => add(item, item.safety !== "red_flag")} onCallEnded={() => void refresh()} /> : null}

      <section aria-labelledby="followup-history" className="space-y-3">
        <h2 id="followup-history" className="text-xl font-semibold text-slate-900">
          {t("historyTitle")}
        </h2>
        {items.length === 0 ? (
          <p className="text-slate-600">{t("historyEmpty")}</p>
        ) : (
          <ul className="space-y-3" aria-live="polite">
            {items.map((item) => (
              <AnswerCard key={item.id} item={item} childId={childId} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
