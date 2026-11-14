"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { withConsentHint } from "@/lib/consent/features";
import { EMAIL_STATUS_TEXT, isEmailStatus, type EmailStatus } from "@/lib/parentNoteStatus";
import { Button } from "@/components/ui/Button";

export type NoteView = { text: string; hasAudio: boolean; audioUrl: string | null; emailStatus: EmailStatus | null };

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;
export type NoteResult = { ok: true; note: NoteView } | { ok: false; error: string };

// The POST response has no signed URL; the page refresh supplies the player URL.
export async function createVoiceNote(fetchFn: FetchFn, reportId: string): Promise<NoteResult> {
  try {
    const res = await fetchFn(`/api/reports/${reportId}/parent-voice-note`, { method: "POST" });
    const body = (await res.json().catch(() => ({}))) as {
      report?: { content_md?: string; audio_path?: string | null };
      email_status?: unknown;
      error?: string;
    };
    if (!res.ok || !body.report) return { ok: false, error: body.error ? withConsentHint(body.error) : "Voice note could not be created" };
    return {
      ok: true,
      note: {
        text: body.report.content_md ?? "",
        hasAudio: Boolean(body.report.audio_path),
        audioUrl: null,
        emailStatus: isEmailStatus(body.email_status) ? body.email_status : null,
      },
    };
  } catch {
    return { ok: false, error: "Voice note could not be created" };
  }
}

export function buttonLabel(note: NoteView | null): string {
  return note ? "Recreate and send" : "Create and send voice note";
}

export function ParentVoiceNote({ reportId, initialNote }: { reportId: string; initialNote: NoteView | null }) {
  const router = useRouter();
  const [note, setNote] = useState<NoteView | null>(initialNote);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fetchFn: FetchFn = (input, init) => fetch(input, init);

  async function onCreate() {
    setBusy(true);
    setError(null);
    const result = await createVoiceNote(fetchFn, reportId);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setNote(result.note);
    router.refresh();
  }

  return (
    <section aria-labelledby="parent-note-heading" className="space-y-3 rounded border border-slate-200 p-4">
      <h2 id="parent-note-heading" className="text-lg font-semibold">
        Parent voice note
      </h2>
      {note && (
        <div className="space-y-2">
          <p className="whitespace-pre-wrap text-slate-900">{note.text}</p>
          {note.audioUrl ? (
            <audio controls src={note.audioUrl} className="w-full" />
          ) : (
            <p className="text-sm text-slate-700">
              {note.hasAudio ? "Voice note audio is unavailable" : "Voice note skipped in demo mode"}
            </p>
          )}
          {note.emailStatus && (
            <p role="status" className="text-sm text-slate-700">
              {EMAIL_STATUS_TEXT[note.emailStatus]}
            </p>
          )}
        </div>
      )}
      <Button
        type="button"
        disabled={busy}
        onClick={onCreate}
      >
        {buttonLabel(note)}
      </Button>
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
    </section>
  );
}
