// 015: pure helpers for the parent voice note (no I/O except reading the prompt file).
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { EmailStatus } from "@/lib/parentNoteStatus";
import type { Language, ReportRow } from "@/lib/types";

export { EMAIL_STATUS_TEXT, isEmailStatus, type EmailStatus } from "@/lib/parentNoteStatus";
export type ParentSummaryRow = ReportRow & { email_status: EmailStatus | null };

export const VOICE_NOTE_FAILED = "Voice note could not be created";
export const AUDIO_LINK_TTL_SEC = 7 * 24 * 60 * 60; // D-4
export const AUDIO_PLAYER_TTL_SEC = 60 * 60;

const LANGUAGE_NAMES: Record<Language, string> = { en: "English", hi: "Hindi (Devanagari script)", te: "Telugu (Telugu script)" };

export function buildParentSummaryPrompt(input: { language: Language; parentAlias: string; childAlias: string; reportMd: string }): string {
  return [
    `Parent's language: ${input.language} - ${LANGUAGE_NAMES[input.language]}`,
    `Parent: ${input.parentAlias}`,
    `Child: ${input.childAlias}`,
    "",
    "Final assessment report (for you only; do not read out scores, totals or bands):",
    input.reportMd,
  ].join("\n");
}

// NFR-2: the parent text must never carry score-like numbers or instrument names.
const SCORE_LIKE = /ISAA|FACP|\/\s*\d+|\b(?:[4-9]\d|1\d\d|200)\b|[౪-౯४-९][౦-౯०-९]/i;
export function looksLikeScore(text: string): boolean {
  return SCORE_LIKE.test(text);
}

export function noteView(row: ParentSummaryRow | null, audioUrl: string | null) {
  if (!row) return null;
  return {
    text: row.content_md,
    hasAudio: row.audio_path !== null,
    audioUrl: row.audio_path ? audioUrl : null,
    emailStatus: row.email_status,
  };
}

export function emailSubject(therapist: string, child: string): string {
  return `A voice note from ${therapist} about ${child}`;
}

export function emailText(summary: string, audioUrl: string | null): string {
  return audioUrl ? `${summary}\n\nListen to the voice note (link valid for 7 days):\n${audioUrl}` : summary;
}

// A new object per generation, so a link in an earlier email keeps working.
export function audioObjectPath(caseId: string, assessmentReportId: string, id: string = randomUUID()): string {
  return `${caseId}/parent-note-${assessmentReportId}-${id}.mp3`;
}

let cachedSystem: string | null = null;
export function parentSummarySystemPrompt(): string {
  cachedSystem ??= readFileSync(path.join(process.cwd(), "prompts", "parent-summary.md"), "utf8");
  return cachedSystem;
}
