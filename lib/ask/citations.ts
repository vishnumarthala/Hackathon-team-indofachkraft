// Pure citation handling for "Ask the case" (ticket 013). Safe to import from client components.
import { z } from "zod";
import type { AskAnswer } from "@/lib/types";

export const NOT_DOCUMENTED = "Not documented in this case.";

export const ResolvedCitationSchema = z.object({
  kind: z.enum(["fact", "segment"]),
  id: z.string(),
  recording_id: z.string(),
  session_number: z.number().int().nullable(),
  start_sec: z.number(),
  label: z.string(),
});
export type ResolvedCitation = z.infer<typeof ResolvedCitationSchema>;

export type AskResult = { found: boolean; answer: string; citations: ResolvedCitation[] };

/** What a recording looks like to the citation resolver. */
export type CitationRecording = { id: string; kind: "intake_call" | "session"; session_number: number | null };

/** The fact fields the resolver needs (a subset of FactRow). */
export type CitationFact = {
  id: string;
  instrument: "ISAA" | "CASE_SHEET";
  item_id: string;
  recording_id: string;
  evidence: { recording_id: string; start_sec: number } | null;
};

/** Every id that was actually sent to the model, already resolved to a moment in a recording. */
export type CitableContext = {
  facts: Map<string, ResolvedCitation>;
  segments: Map<string, ResolvedCitation>;
};

export function clock(sec: number): string {
  const total = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

export function momentLabel(recording: CitationRecording | undefined, startSec: number): string {
  if (recording?.kind === "intake_call") return `Intake call · ${clock(startSec)}`;
  return `Session ${recording?.session_number ?? "?"} · ${clock(startSec)}`;
}

/** Segment ids in the prompt: `<session_number>:<segment id>` or `intake:<turn id>` (D-2). */
export function segmentKey(recording: CitationRecording, segmentId: string): string {
  return recording.kind === "intake_call" ? `intake:${segmentId}` : `${recording.session_number}:${segmentId}`;
}

export function segmentCitation(recording: CitationRecording, segment: { id: string; start_sec: number }): ResolvedCitation {
  return {
    kind: "segment",
    id: segmentKey(recording, segment.id),
    recording_id: recording.id,
    session_number: recording.kind === "session" ? recording.session_number : null,
    start_sec: segment.start_sec,
    label: momentLabel(recording, segment.start_sec),
  };
}

/** Facts point at their evidence segment; facts without evidence point at the start of their recording. */
export function factCitation(fact: CitationFact, recordings: Map<string, CitationRecording>): ResolvedCitation {
  if (fact.evidence) {
    const recording = recordings.get(fact.evidence.recording_id);
    return {
      kind: "fact",
      id: fact.id,
      recording_id: fact.evidence.recording_id,
      session_number: recording?.kind === "session" ? recording.session_number : null,
      start_sec: fact.evidence.start_sec,
      label: momentLabel(recording, fact.evidence.start_sec),
    };
  }
  const recording = recordings.get(fact.recording_id);
  const sessionNumber = recording?.kind === "session" ? recording.session_number : null;
  return {
    kind: "fact",
    id: fact.id,
    recording_id: fact.recording_id,
    session_number: sessionNumber,
    start_sec: 0,
    label:
      fact.instrument === "CASE_SHEET" ? "Intake answers" : `Session ${sessionNumber ?? "?"} · ISAA item ${fact.item_id}`,
  };
}

/**
 * FR-3: keep only citations whose id was in the context actually sent (after truncation), dedupe them,
 * and turn an uncited "found" answer into "Not documented in this case.". Nothing else leaves the server.
 */
export function resolveAnswer(answer: AskAnswer, context: CitableContext): AskResult {
  const citations: ResolvedCitation[] = [];
  const seen = new Set<string>();
  if (answer.found) {
    for (const citation of answer.citations) {
      // The prompt shows facts as `[fact:<uuid>]`; accept the id with or without that prefix.
      const id = citation.kind === "fact" ? citation.id.trim().replace(/^fact:/, "") : citation.id.trim();
      const resolved = citation.kind === "fact" ? context.facts.get(id) : context.segments.get(id);
      const key = `${citation.kind}:${id}`;
      if (!resolved || seen.has(key)) continue;
      seen.add(key);
      citations.push(resolved);
    }
  }
  const text = answer.answer.trim();
  if (!answer.found || citations.length === 0 || text === "") {
    return { found: false, answer: NOT_DOCUMENTED, citations: [] };
  }
  return { found: true, answer: text, citations };
}

/**
 * A citation chip may play only when its recording has a signed URL and that URL has not expired.
 * `expiresAt`/`now` are epoch milliseconds.
 */
export function isPlayable(input: { hasAudio: boolean; expiresAt: number; now: number }): boolean {
  return input.hasAudio && Number.isFinite(input.expiresAt) && input.now < input.expiresAt;
}

// Signed audio URLs live 1 hour (getAudioUrls); stop offering playback a few minutes before they expire.
export const AUDIO_PLAYABLE_MS = 55 * 60 * 1000;

export function audioPlayableUntil(signedAt: number = Date.now()): number {
  return signedAt + AUDIO_PLAYABLE_MS;
}
