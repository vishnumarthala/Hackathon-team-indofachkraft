// Ticket 024 FR-8: the published summary of a reviewed questionnaire (published_versions, entity_type
// 'assessment'). Pure. English clinical content (question text has no reviewed translation yet). The reviewer's
// note is internal and never part of the summary.
import { CHECKIN, URGENT_COPY, type CheckinScore } from "@/lib/clinical/checkin";
import { getInstrument } from "@/lib/clinical/instruments";
import { formatDate } from "@/lib/i18n/format";

const TZ = "Asia/Kolkata";

export type SummaryInput = {
  title: string;
  instrumentKey: string;
  submittedAt: string | Date;
  reviewedAt: string | Date;
  score: CheckinScore | null;
  answers: Record<string, unknown>;
};

const day = (value: string | Date) => formatDate(value, "en", "long", TZ);

export function assessmentSummaryMarkdown(input: SummaryInput): string {
  const lines = [
    `# ${input.title}`,
    "",
    `Answered by the parent on ${day(input.submittedAt)}. Reviewed by the care team on ${day(input.reviewedAt)}.`,
    "",
  ];
  if (input.instrumentKey === "ISAA_PARENT_CHECKIN" && input.score) {
    lines.push("## Result", "", input.score.result_text ?? input.score.disclaimer, "");
    const flagged = CHECKIN.red_flags.filter((r) => input.answers[r.id] === "yes");
    if (flagged.length > 0) {
      lines.push("## Safety questions answered yes", "");
      for (const r of flagged) lines.push(`- ${r.text_en}`);
      lines.push("", URGENT_COPY, "");
    }
  } else {
    const instrument = getInstrument(input.instrumentKey);
    lines.push("## Answers", "");
    for (const item of instrument?.items ?? []) {
      const value = input.answers[item.id];
      if (value !== undefined) lines.push(`- ${item.text}: ${String(value)}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}
