import { BriefSchema, type Brief, type RedFlagType, type Segment } from "@/lib/types";

export const RED_FLAG_LABELS: Record<RedFlagType, string> = {
  lost_speech: "Lost speech",
  self_injury: "Self-injury",
  other: "Other",
};

export function redFlagLabel(type: string): string {
  return RED_FLAG_LABELS[type as RedFlagType] ?? "Other";
}

export function formatTime(sec: number): string {
  const total = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

// FR-4: the Markdown the therapist reads (stored as reports.content_md).
export function renderBriefMarkdown(brief: Brief, segments: Segment[]): string {
  const lines = ["## Pre-session brief (parent-reported)", "", brief.summary, "", "### Red flags", ""];
  if (brief.red_flags.length === 0) lines.push("- None reported");
  for (const flag of brief.red_flags) {
    const seg = segments.find((s) => s.id === flag.turn_id);
    const at = seg ? ` (${formatTime(seg.start_sec)})` : "";
    lines.push(`- ${redFlagLabel(flag.type)}: "${flag.quote}"${at}`);
  }
  lines.push("", "### Questions to verify", "");
  brief.questions_to_verify.forEach((q, i) => lines.push(`${i + 1}. ${q}`));
  lines.push("", "### What the parent reported", "", "| Topic | Answer |", "| --- | --- |");
  for (const row of brief.parent_reported) lines.push(`| ${cell(row.label)} | ${cell(row.value)} |`);
  return lines.join("\n") + "\n";
}

export type BriefFlagView = { label: string; quote: string; time: string | null };
export type BriefView = {
  summary: string;
  red_flags: BriefFlagView[];
  questions_to_verify: string[];
  parent_reported: Array<{ label: string; value: string }>;
};
export type BriefState =
  | { kind: "none" }
  | { kind: "failed" }
  | { kind: "brief"; brief: BriefView; status: "draft" | "final" };

// FR-8: what the Brief tab shows for a case's intake recording and brief report (pure, server-safe).
export function briefStateFrom(
  intake: { recording: { segments: Segment[] | null }; report: { content: unknown; status: string } | null } | null,
): BriefState {
  if (!intake) return { kind: "none" };
  if (!intake.report) return { kind: "failed" };
  const parsed = BriefSchema.safeParse(intake.report.content);
  if (!parsed.success) return { kind: "failed" };
  const segments = Array.isArray(intake.recording.segments) ? intake.recording.segments : [];
  const brief = parsed.data;
  return {
    kind: "brief",
    status: intake.report.status === "final" ? "final" : "draft",
    brief: {
      summary: brief.summary,
      red_flags: brief.red_flags.map((f) => {
        const seg = segments.find((s) => s.id === f.turn_id);
        return { label: redFlagLabel(f.type), quote: f.quote, time: seg ? formatTime(seg.start_sec) : null };
      }),
      questions_to_verify: brief.questions_to_verify,
      parent_reported: brief.parent_reported.map((r) => ({ label: r.label, value: r.value })),
    },
  };
}
