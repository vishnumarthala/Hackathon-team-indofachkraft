// Ticket 046 FR-7: the monthly platform-fee tax invoice (PDF, pdf-lib like 045's receipt). From DoctorNearMe (legal
// name, GSTIN, address from env, frozen on the invoice row) to the centre (legal name, GSTIN if given): the platform
// fee for the month's consultations, GST on it (CGST + SGST inside the platform's state, else IGST) and the total, which
// was already deducted from the payouts. Rendered on demand from the immutable invoice row (deterministic dates).
// Open question (CA): the exact invoice format, SAC code and place-of-supply rule.
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { pdfInr } from "@/lib/fees/receipt";
import { gstLines } from "./fees";
import type { InvoiceRow } from "./store";

const IST_DATE = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" });
const MONTH = new Intl.DateTimeFormat("en-IN", { timeZone: "UTC", month: "long", year: "numeric" });

/** SAC 998599 (other support services) - placeholder until the CA confirms the code. */
export const PLATFORM_FEE_SAC = "998599";

export function invoiceFileName(invoiceNo: string): string {
  return `${invoiceNo.replace(/\//g, "-")}.pdf`;
}

export function invoiceMonthLabel(periodMonth: string): string {
  return MONTH.format(new Date(`${periodMonth}T00:00:00Z`));
}

export async function renderInvoicePdf(inv: InvoiceRow): Promise<Uint8Array> {
  const at = new Date(inv.issued_at);
  const pdf = await PDFDocument.create({ updateMetadata: false });
  pdf.setTitle(`Tax invoice ${inv.invoice_no}`);
  pdf.setAuthor("DoctorNearMe");
  pdf.setSubject("Platform fee tax invoice");
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
  const line = () => page.drawLine({ start: { x: left, y }, end: { x: right, y }, thickness: 0.5, color: muted });

  text(inv.platform.legal_name || "DoctorNearMe", { size: 20, b: true });
  y -= 18;
  if (inv.platform.address) {
    text(inv.platform.address.slice(0, 110), { size: 9, color: muted });
    y -= 13;
  }
  text(`GSTIN: ${inv.platform.gstin ?? "not registered yet"}`, { size: 9, color: muted });
  y -= 28;
  text("Tax invoice - platform fee", { size: 14, b: true });
  y -= 22;
  text(`Invoice no. ${inv.invoice_no}`);
  y -= 16;
  text(`Date: ${IST_DATE.format(at)}`);
  y -= 16;
  text(`Period: ${invoiceMonthLabel(inv.period_month)}`);
  y -= 26;
  text("Billed to", { b: true, color: muted });
  y -= 16;
  text(inv.centre.legal_name || inv.centre.name);
  y -= 16;
  if (inv.centre.legal_name && inv.centre.legal_name !== inv.centre.name) {
    text(`(${inv.centre.name})`, { size: 9, color: muted });
    y -= 14;
  }
  text(`GSTIN: ${inv.centre.gstin ?? "unregistered"}`, { size: 10 });
  y -= 30;

  text("Description", { b: true, color: muted });
  amountAt("Amount", { b: true });
  y -= 6;
  line();
  y -= 18;
  text(`Platform fee (SAC ${PLATFORM_FEE_SAC}) for ${inv.item_count} consultation${inv.item_count === 1 ? "" : "s"}`);
  amountAt(pdfInr(inv.fee_paise));
  y -= 16;
  text(`Consultation value paid by families: ${pdfInr(inv.gross_paise)}`, { size: 9, color: muted });
  y -= 18;
  for (const g of gstLines(inv.gst_paise, inv.platform.gstin, inv.centre.gstin)) {
    text(g.label);
    amountAt(pdfInr(g.paise));
    y -= 18;
  }
  y += 8;
  line();
  y -= 18;
  text("Total (fee + GST)", { b: true });
  amountAt(pdfInr(inv.fee_paise + inv.gst_paise), { b: true });
  y -= 34;
  for (const note of [
    "Already deducted from your payouts: nothing to pay. DoctorNearMe collects each consultation fee on behalf of the",
    "centre and pays the rest to the centre's Razorpay linked account after each session (Razorpay Route).",
    "Amounts in Indian rupees.",
  ]) {
    text(note, { size: 9, color: muted });
    y -= 13;
  }
  return pdf.save({ useObjectStreams: false });
}
