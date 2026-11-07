import type { Segment, SpeakerRole } from "@/lib/types";

// One entry of a Scribe v2 `words` array.
export type ScribeWord = {
  text: string;
  start?: number | null;
  end?: number | null;
  type: "word" | "spacing" | "audio_event";
  speaker_id?: string | null;
};

export const MAX_GAP_SEC = 1.5;
export const MAX_SEGMENT_SEC = 30;
const DEFAULT_SPEAKER = "speaker_0";

type Draft = { speaker: string; parts: string[]; start: number; end: number };

const round2 = (n: number) => Math.round(n * 100) / 100;

// Consecutive entries of one speaker form a segment. A new segment starts on a speaker change,
// a gap > 1.5 s between two timed entries, or when the segment would last longer than 30 s.
// Spacing entries only join a segment when the next timed entry stays in it.
export function buildSegments(words: ScribeWord[]): Segment[] {
  const drafts: Draft[] = [];
  let current: Draft | null = null;
  let pendingSpacing: string[] = [];

  for (const entry of words) {
    if (entry.type === "spacing") {
      if (current) pendingSpacing.push(entry.text);
      continue;
    }
    const speaker = entry.speaker_id ?? DEFAULT_SPEAKER;
    const start: number = entry.start ?? current?.end ?? 0;
    const end: number = entry.end ?? start;

    const split =
      !current ||
      speaker !== current.speaker ||
      start - current.end > MAX_GAP_SEC ||
      end - current.start > MAX_SEGMENT_SEC;

    if (split) {
      current = { speaker, parts: [entry.text], start, end };
      drafts.push(current);
    } else if (current) {
      current.parts.push(...pendingSpacing, entry.text);
      current.end = Math.max(current.end, end);
    }
    pendingSpacing = [];
  }

  return drafts.map((d, i) => ({
    id: `s${i + 1}`,
    speaker: "unknown" as SpeakerRole,
    speaker_label: d.speaker,
    start_sec: round2(d.start),
    end_sec: round2(d.end),
    text: d.parts.join("").trim(),
  }));
}

// The speaker who dictates a "Note: ..." is the therapist; everybody else is the parent.
// Without a note, the first segment's speaker is the therapist.
export function mapSpeakers(segments: Segment[]): { segments: Segment[]; speaker_map: Record<string, SpeakerRole> } {
  if (segments.length === 0) return { segments: [], speaker_map: {} };
  const noteSpeaker = segments.find((s) => /^note/i.test(s.text.trim()))?.speaker_label;
  const therapist = noteSpeaker ?? segments[0].speaker_label;

  const speaker_map: Record<string, SpeakerRole> = {};
  for (const s of segments) speaker_map[s.speaker_label] ??= s.speaker_label === therapist ? "therapist" : "parent";

  return { segments: segments.map((s) => ({ ...s, speaker: speaker_map[s.speaker_label] })), speaker_map };
}

export function formatTime(sec: number): string {
  const total = Math.max(0, Math.floor(sec));
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

export function toPromptLines(segments: Segment[]): string[] {
  return segments.map(
    (s) => `[${s.id} | ${formatTime(s.start_sec)}-${formatTime(s.end_sec)} | ${s.speaker.toUpperCase()}] ${s.text}`,
  );
}
