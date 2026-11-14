// Ticket 046 FR-7: the centre's payout export (one row per payout item; amounts in rupees with 2 decimals).
import { csvLine, rupees } from "./fees";
import type { PayoutItemRow } from "./store";

export const CSV_HEADER = [
  "session_date",
  "session_time_ist",
  "service",
  "child",
  "kind",
  "consultation_inr",
  "platform_fee_inr",
  "gst_inr",
  "net_inr",
  "fee_waived",
  "status",
  "razorpay_transfer_id",
  "processed_at",
];

const IST_TIME = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false });

export function payoutCsv(items: PayoutItemRow[]): string {
  const lines = [csvLine(CSV_HEADER)];
  for (const i of items) {
    lines.push(
      csvLine([
        i.consultation_on,
        i.session_at ? IST_TIME.format(new Date(i.session_at)) : "",
        i.service,
        i.child_name,
        i.kind,
        rupees(i.consultation_paise),
        rupees(i.fee_paise),
        rupees(i.gst_paise),
        rupees(i.net_paise),
        i.fee_waived ? "yes" : "no",
        i.status,
        i.razorpay_transfer_id,
        i.processed_at,
      ]),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}
