// Pure speaker-swap rules (008 FR-6). No server imports, so the review screen can use them too.
import type { Segment, SpeakerRole } from "@/lib/types";

export function swapRole(role: SpeakerRole): SpeakerRole {
  if (role === "therapist") return "parent";
  if (role === "parent") return "therapist";
  return role;
}

export function swapSpeakerMap(map: Record<string, SpeakerRole>): Record<string, SpeakerRole> {
  return Object.fromEntries(Object.entries(map).map(([label, role]) => [label, swapRole(role)]));
}

export function swapSegments(segments: Segment[]): Segment[] {
  return segments.map((s) => ({ ...s, speaker: swapRole(s.speaker) }));
}

// A manual therapist decision: an edited item, or a confirmed one that is not an untouched voice note.
export function isManualDecision(fact: { status: string; source: string }): boolean {
  return fact.status === "edited" || (fact.status === "confirmed" && fact.source !== "therapist_voice");
}
