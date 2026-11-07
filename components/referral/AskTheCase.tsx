"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useEvidencePlayer } from "@/components/referral/EvidencePlayer";
import { isPlayable, type AskResult, type ResolvedCitation } from "@/lib/ask/citations";

export type AskEntry = AskResult & { id: string; question: string };

export const SUGGESTIONS = ["When did speech regress?", "Any self-injury?", "How does he respond to his name?"];

function CitationChip({ citation, audioExpired }: { citation: ResolvedCitation; audioExpired: boolean }) {
  const { play, canPlay, current } = useEvidencePlayer();
  const playable = canPlay(citation.recording_id) && !audioExpired;
  const active = current?.recordingId === citation.recording_id && current.startSec === Math.max(0, citation.start_sec);
  return (
    <button
      type="button"
      disabled={!playable}
      title={playable ? "Play this moment" : audioExpired ? "Audio link expired - reload the page" : "No audio for this recording"}
      aria-pressed={playable ? active : undefined}
      onClick={() => {
        if (playable) play(citation.recording_id, citation.start_sec);
      }}
      className={`rounded border px-2 py-0.5 text-sm font-medium ${
        !playable
          ? "cursor-default border-slate-300 bg-slate-50 text-slate-600"
          : active
            ? "border-sky-700 bg-sky-700 text-white"
            : "border-sky-300 bg-sky-50 text-sky-900 hover:bg-sky-100"
      }`}
    >
      {citation.label}
    </button>
  );
}

export function AskTheCase({
  caseId,
  shareToken,
  initialQuestions,
  audioExpiresAt,
}: {
  caseId: string;
  shareToken: string;
  initialQuestions: AskEntry[];
  /** Epoch ms after which the page's signed audio URLs must not be used. */
  audioExpiresAt: number;
}) {
  const [entries, setEntries] = useState<AskEntry[]>(initialQuestions);
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [audioExpired, setAudioExpired] = useState(false);

  useEffect(() => {
    const check = () => setAudioExpired(!isPlayable({ hasAudio: true, expiresAt: audioExpiresAt, now: Date.now() }));
    const timer = setTimeout(check, Math.max(0, Math.min(audioExpiresAt - Date.now(), 2 ** 31 - 1)));
    // Timers may fire late after the tab sleeps; re-check whenever the page becomes visible again.
    document.addEventListener("visibilitychange", check);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", check);
    };
  }, [audioExpiresAt]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (asking) return;
    setAsking(true);
    setError(null);
    try {
      const res = await fetch(`/api/cases/${caseId}/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ share_token: shareToken, question }),
      });
      const body = (await res.json().catch(() => null)) as
        | (AskResult & { error?: undefined })
        | { error: string; details?: Record<string, string> }
        | null;
      if (!res.ok || !body || body.error !== undefined) {
        const details = body && "details" in body && body.details ? Object.values(body.details)[0] : undefined;
        setError(body?.error ? (details ? `${body.error}: ${details}` : body.error) : "The question could not be answered");
        return;
      }
      const result = body as AskResult;
      setEntries((prev) => [
        ...prev,
        { id: `local-${prev.length}-${Date.now()}`, question: question.trim(), ...result },
      ]);
      setQuestion("");
    } catch {
      setError("The question could not be answered");
    } finally {
      setAsking(false);
    }
  }

  return (
    <section aria-labelledby="ask-the-case" className="mt-8 rounded border border-slate-200 p-4">
      <h2 id="ask-the-case" className="text-lg font-semibold">
        Ask the case
      </h2>
      <p className="mt-1 text-sm text-slate-600">
        Answers come only from this case&apos;s confirmed facts, intake answers and transcripts, with a link to
        each moment. AI documents, the clinician decides.
      </p>

      {entries.length > 0 && (
        <ol className="mt-4 space-y-4">
          {entries.map((entry) => (
            <li key={entry.id} className="border-l-2 border-slate-200 pl-3">
              <p className="font-medium">{entry.question}</p>
              <p className={`mt-1 ${entry.found ? "text-slate-900" : "text-slate-500"}`}>{entry.answer}</p>
              {entry.citations.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-2" aria-label="Sources">
                  {entry.citations.map((citation) => (
                    <CitationChip key={`${citation.kind}:${citation.id}`} citation={citation} audioExpired={audioExpired} />
                  ))}
                </div>
              )}
            </li>
          ))}
        </ol>
      )}

      <form onSubmit={onSubmit} className="mt-4 space-y-2">
        <label htmlFor="ask-question" className="block text-sm font-medium">
          Your question
        </label>
        <textarea
          id="ask-question"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          maxLength={500}
          rows={3}
          className="w-full rounded border border-slate-300 p-2"
        />
        <div className="flex flex-wrap gap-2">
          {SUGGESTIONS.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              onClick={() => setQuestion(suggestion)}
              className="rounded-full border border-slate-300 px-3 py-1 text-sm hover:bg-slate-100"
            >
              {suggestion}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={asking}
            className="rounded bg-sky-700 px-4 py-2 font-medium text-white hover:bg-sky-800 disabled:opacity-60"
          >
            {asking ? "Asking…" : "Ask"}
          </button>
          {error && (
            <p role="alert" className="text-sm text-red-700">
              {error}
            </p>
          )}
        </div>
      </form>
    </section>
  );
}
