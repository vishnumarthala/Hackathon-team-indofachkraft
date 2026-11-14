import { statusLabel } from "@/lib/cases/format";
import { Badge, type BadgeTone } from "@/components/ui/Badge";

const TONES: Record<string, BadgeTone> = {
  booked: "neutral",
  intake_done: "info",
  in_assessment: "warning",
  referred: "success",
};

export function caseStatusTone(status: string): BadgeTone {
  return TONES[status] ?? TONES.booked;
}

export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={caseStatusTone(status)}>{statusLabel(status)}</Badge>;
}
