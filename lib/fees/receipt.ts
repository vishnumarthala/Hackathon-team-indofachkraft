// Ticket 045 FR-6: the DoctorNearMe receipt (PDF, pdf-lib like 039). "Paid to DoctorNearMe on behalf of <centre>", the
// items, the amount, the Razorpay payment id and the date. No child name, no card or UPI details. Deterministic: the
// document dates are the capture time. Standard Helvetica (WinAnsi): amounts print as "Rs." (no rupee glyph).
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { pg } from "@/lib/pg";

export type ReceiptItem = { label: string; amount_paise: number };
export type Receipt = {
  payment_id: string;
  receipt_no: string;
  captured_at: string;
  org_name: string;
  amount_paise: number;
  razorpay_payment_id: string | null;
  purpose: "appointment" | "package" | "balance";
  items: ReceiptItem[];
  refunded_paise: number;
};

const IST_DATE = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" });
const IST_DATE_TIME = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

export function pdfInr(paise: number): string {
  const rupees = new Intl.NumberFormat("en-IN", { minimumFractionDigits: paise % 100 ? 2 : 0, maximumFractionDigits: 2 }).format(paise / 100);
  return `Rs. ${rupees}`;
}

/** The receipt of a captured payment (null when there is none, e.g. not captured). */
export async function loadReceipt(paymentId: string): Promise<Receipt | null> {
  const sql = await pg();
  const [p] = await sql`
    select p.id, p.purpose, p.receipt_no, p.captured_at, p.amount_paise, p.razorpay_payment_id, p.status,
           o.name as org_name, a.service_snapshot ->> 'name' as service, lower(a.slot) as starts_at,
           cp.snapshot ->> 'name' as package_name, cp.sessions_total
    from public.payments p
    left join public.appointments a on a.id = p.appointment_id
    left join public.child_packages cp on cp.id = p.child_package_id
    join public.organizations o on o.id = coalesce(p.org_id, a.org_id)
    where p.id = ${paymentId}`;
  if (!p?.receipt_no || !p.captured_at) return null;
  const items: ReceiptItem[] = [];
  if (p.purpose === "appointment") {
    items.push({ label: `${p.service ?? "Appointment"} - ${IST_DATE.format(new Date(p.starts_at as Date))}`, amount_paise: Number(p.amount_paise) });
  } else if (p.purpose === "package") {
    items.push({ label: `Package: ${p.package_name ?? "sessions"} (${p.sessions_total} sessions)`, amount_paise: Number(p.amount_paise) });
  } else {
    const covered = await sql`
      select l.kind, l.note, l.created_by, i.amount_paise, lower(a.slot) as starts_at, a.service_snapshot ->> 'name' as service
      from public.fee_link_items i join public.family_ledger l on l.id = i.ledger_id
      left join public.appointments a on a.id = l.appointment_id
      where i.payment_id = ${paymentId} order by l.id`;
    for (const c of covered) {
      const label =
        c.kind === "charge"
          ? `${c.service ?? "Session"} - ${c.starts_at ? IST_DATE.format(new Date(c.starts_at as Date)) : ""}`.replace(/ - $/, "")
          : `Adjustment: ${String(c.note).slice(0, 80)}`;
      items.push({ label, amount_paise: Number(c.amount_paise) });
    }
    if (!items.length) items.push({ label: "Balance", amount_paise: Number(p.amount_paise) });
  }
  const [refunds] = await sql<{ n: string }[]>`
    select (coalesce((select sum(amount_paise) from public.fee_refunds where payment_id = ${paymentId} and status = 'processed'), 0)
            + case when ${String(p.status)} = 'refunded' then ${Number(p.amount_paise)} else 0 end)::text as n`;
  return {
    payment_id: String(p.id),
    receipt_no: String(p.receipt_no),
    captured_at: (p.captured_at as Date).toISOString(),
    org_name: String(p.org_name),
    amount_paise: Number(p.amount_paise),
    razorpay_payment_id: (p.razorpay_payment_id as string | null) ?? null,
    purpose: p.purpose as Receipt["purpose"],
    items,
    refunded_paise: Number(refunds.n),
  };
}

export function receiptFileName(receiptNo: string): string {
  return `${receiptNo.replace(/\//g, "-")}.pdf`;
}

export async function renderReceiptPdf(r: Receipt): Promise<Uint8Array> {
  const at = new Date(r.captured_at);
  const pdf = await PDFDocument.create({ updateMetadata: false });
  pdf.setTitle(`Receipt ${r.receipt_no}`);
  pdf.setAuthor("DoctorNearMe");
  pdf.setSubject("Payment receipt");
  pdf.setCreator("DoctorNearMe");
  pdf.setProducer("DoctorNearMe (pdf-lib)");
  pdf.setCreationDate(at);
  pdf.setModificationDate(at);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const supported = new Set(regular.getCharacterSet());
  const safe = (s: string) => [...s.replace(/\s+/g, " ")].map((ch) => (supported.has(ch.codePointAt(0) as number) ? ch : "?")).join("");
  const page = pdf.addPage([595.28, 841.89]);
  const ink = rgb(0.06, 0.09, 0.16);
  const muted = rgb(0.28, 0.33, 0.41);
  const left = 50;
  const right = 545;
  let y = 790;
  const text = (s: string, opts: { size?: number; b?: boolean; color?: ReturnType<typeof rgb>; x?: number } = {}) => {
    page.drawText(safe(s), { x: opts.x ?? left, y, size: opts.size ?? 11, font: opts.b ? bold : regular, color: opts.color ?? ink });
  };
  const amountAt = (s: string, opts: { b?: boolean } = {}) => {
    const font = opts.b ? bold : regular;
    page.drawText(s, { x: right - font.widthOfTextAtSize(s, 11), y, size: 11, font, color: ink });
  };
  text("DoctorNearMe", { size: 20, b: true });
  y -= 28;
  text("Payment receipt", { size: 14, b: true });
  y -= 22;
  text(`Receipt no. ${r.receipt_no}`);
  y -= 16;
  text(`Date: ${IST_DATE_TIME.format(at)} IST`);
  y -= 16;
  if (r.razorpay_payment_id) {
    text(`Razorpay payment id: ${r.razorpay_payment_id}`);
    y -= 16;
  }
  y -= 10;
  text(`Paid to DoctorNearMe on behalf of ${r.org_name}`, { b: true });
  y -= 30;
  text("Item", { b: true, color: muted });
  amountAt("Amount", { b: true });
  y -= 6;
  page.drawLine({ start: { x: left, y }, end: { x: right, y }, thickness: 0.5, color: muted });
  y -= 18;
  for (const item of r.items.slice(0, 30)) {
    text(item.label.slice(0, 80));
    amountAt(pdfInr(item.amount_paise));
    y -= 18;
  }
  page.drawLine({ start: { x: left, y: y + 8 }, end: { x: right, y: y + 8 }, thickness: 0.5, color: muted });
  y -= 8;
  text("Total paid", { b: true });
  amountAt(pdfInr(r.amount_paise), { b: true });
  y -= 18;
  if (r.refunded_paise > 0) {
    text("Refunded", { color: muted });
    amountAt(`- ${pdfInr(r.refunded_paise)}`);
    y -= 18;
  }
  y -= 24;
  for (const line of [
    "DoctorNearMe collects this payment on behalf of the centre named above and pays the centre after each session.",
    "Paid online through Razorpay. No card or UPI details are stored by DoctorNearMe.",
  ]) {
    text(line, { size: 9, color: muted });
    y -= 13;
  }
  return pdf.save({ useObjectStreams: false });
}
