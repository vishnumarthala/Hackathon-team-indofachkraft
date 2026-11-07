import { statusLabel } from "@/lib/cases/format";

const COLORS: Record<string, string> = {
  booked: "bg-slate-100 text-slate-800",
  intake_done: "bg-sky-100 text-sky-800",
  in_assessment: "bg-amber-100 text-amber-900",
  referred: "bg-emerald-100 text-emerald-800",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${COLORS[status] ?? COLORS.booked}`}>
      {statusLabel(status)}
    </span>
  );
}
