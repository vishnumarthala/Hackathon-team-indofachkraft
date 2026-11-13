// Ticket 039 FR-4 / NFR-2: prescription PDF with `pdf-lib` (the one dependency this ticket adds: pure JS, no native
// code, no headless browser). Deterministic: no "now" anywhere (creation/modification dates = signed_at, fixed
// producer/creator, metadata auto-update off, no object streams), so the same version always renders the same bytes.
// Fonts are the PDF standard Helvetica (WinAnsi): characters outside it (e.g. Devanagari/Telugu names) print as "?"
// in the PDF; `content_md` (authoritative, shown in the app) keeps the original text.
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import {
  AI_NOTE,
  GENERATED_BY,
  allergyLine,
  councilLabel,
  formatIst,
  itemLine,
  registrationLine,
  signatureLine,
  type RxDocument,
} from "./document";

const A4: [number, number] = [595.28, 841.89];
const MARGIN = 50;
const FOOTER_TOP = 110;
const INK = rgb(0.06, 0.09, 0.16);
const MUTED = rgb(0.28, 0.33, 0.41);
const ALERT = rgb(0.6, 0.05, 0.05);

type Fonts = { regular: PDFFont; bold: PDFFont };

/** Replaces characters the standard font cannot encode (and control characters) with "?". */
function safe(value: string, supported: Set<number>): string {
  let out = "";
  for (const ch of value.replace(/\s+/g, " ")) out += supported.has(ch.codePointAt(0) as number) ? ch : "?";
  return out;
}

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= width) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    // A single word wider than the line is cut into pieces.
    let rest = word;
    while (font.widthOfTextAtSize(rest, size) > width && rest.length > 1) {
      let cut = rest.length - 1;
      while (cut > 1 && font.widthOfTextAtSize(rest.slice(0, cut), size) > width) cut -= 1;
      lines.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    line = rest;
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

class Writer {
  page: PDFPage;
  y: number;
  readonly pages: PDFPage[] = [];
  constructor(
    private readonly pdf: PDFDocument,
    private readonly fonts: Fonts,
    private readonly supported: Set<number>,
  ) {
    this.page = this.newPage();
    this.y = A4[1] - MARGIN;
  }

  private newPage(): PDFPage {
    const page = this.pdf.addPage(A4);
    this.pages.push(page);
    return page;
  }

  private ensure(height: number) {
    if (this.y - height < FOOTER_TOP) {
      this.page = this.newPage();
      this.y = A4[1] - MARGIN;
    }
  }

  text(value: string, opts: { size?: number; bold?: boolean; color?: ReturnType<typeof rgb>; indent?: number; gap?: number } = {}) {
    const size = opts.size ?? 10.5;
    const font = opts.bold ? this.fonts.bold : this.fonts.regular;
    const indent = opts.indent ?? 0;
    const width = A4[0] - 2 * MARGIN - indent;
    for (const line of wrap(safe(value, this.supported), font, size, width)) {
      this.ensure(size * 1.35);
      this.y -= size * 1.35;
      this.page.drawText(line, { x: MARGIN + indent, y: this.y, size, font, color: opts.color ?? INK });
    }
    this.y -= opts.gap ?? 0;
  }

  labelled(label: string, value: string, color?: ReturnType<typeof rgb>) {
    const size = 10.5;
    const labelText = `${label}: `;
    const labelWidth = this.fonts.bold.widthOfTextAtSize(labelText, size);
    const lines = wrap(safe(value, this.supported), this.fonts.regular, size, A4[0] - 2 * MARGIN - labelWidth);
    lines.forEach((line, i) => {
      this.ensure(size * 1.35);
      this.y -= size * 1.35;
      if (i === 0) this.page.drawText(labelText, { x: MARGIN, y: this.y, size, font: this.fonts.bold, color: INK });
      this.page.drawText(line, { x: MARGIN + labelWidth, y: this.y, size, font: this.fonts.regular, color: color ?? INK });
    });
  }

  rule(gap = 8) {
    this.ensure(gap * 2);
    this.y -= gap;
    this.page.drawLine({ start: { x: MARGIN, y: this.y }, end: { x: A4[0] - MARGIN, y: this.y }, thickness: 0.6, color: MUTED });
    this.y -= gap;
  }

  space(h: number) {
    this.y -= h;
  }

  footer(lines: string[]) {
    const size = 8;
    this.pages.forEach((page, index) => {
      let y = FOOTER_TOP - 18;
      page.drawLine({ start: { x: MARGIN, y: FOOTER_TOP - 6 }, end: { x: A4[0] - MARGIN, y: FOOTER_TOP - 6 }, thickness: 0.6, color: MUTED });
      for (const raw of [...lines, `Page ${index + 1} of ${this.pages.length}`]) {
        for (const line of wrap(safe(raw, this.supported), this.fonts.regular, size, A4[0] - 2 * MARGIN)) {
          page.drawText(line, { x: MARGIN, y, size, font: this.fonts.regular, color: MUTED });
          y -= size * 1.4;
        }
      }
    });
  }
}

/** Renders the signed version. `contentHash` = sha256 of `prescriptionMarkdown(doc)` (printed in the footer). */
export async function renderPrescriptionPdf(doc: RxDocument, contentHash: string): Promise<Uint8Array> {
  const signedAt = new Date(doc.signed_at);
  const pdf = await PDFDocument.create({ updateMetadata: false });
  pdf.setTitle(`Prescription - ${formatIst(doc.signed_at)}`);
  pdf.setAuthor(doc.prescriber.name);
  pdf.setSubject("Prescription");
  pdf.setCreator("DoctorNearMe");
  pdf.setProducer("DoctorNearMe (pdf-lib)");
  pdf.setCreationDate(signedAt);
  pdf.setModificationDate(signedAt);
  const fonts: Fonts = {
    regular: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
  };
  const supported = new Set(fonts.regular.getCharacterSet());
  const w = new Writer(pdf, fonts, supported);
  const p = doc.prescriber;

  w.text("Prescription", { size: 18, bold: true, gap: 6 });
  w.text(p.name, { size: 13, bold: true });
  if (p.qualifications) w.text(p.qualifications, { color: MUTED });
  w.text(`${councilLabel(p.council, p.council_state)} - Registration No. ${p.registration_number}`);
  w.text([p.org, p.address].filter(Boolean).join(", "), { color: MUTED });
  w.labelled("Date", formatIst(doc.signed_at));
  w.rule();

  w.labelled("Child", `${doc.child.name}${doc.child.age ? `, ${doc.child.age}` : ", age not recorded"}`);
  if (doc.child.weight_kg != null) w.labelled("Weight", `${doc.child.weight_kg} kg`);
  w.labelled("Allergies", allergyLine(doc.allergies), doc.allergies.status === "none_known" ? undefined : ALERT);
  if (doc.allergies.override_reason) {
    const names = [...new Set(doc.allergies.matches.map((m) => m.drug))].join(", ");
    w.labelled("Allergy override", `${names} - ${doc.allergies.override_reason}`, ALERT);
  }
  w.rule();

  w.text("Rx", { size: 14, bold: true, gap: 4 });
  doc.items.forEach((item, i) => {
    w.text(`${i + 1}. ${itemLine(item)}`, { gap: 1 });
    if (item.instructions) w.text(`Instructions: ${item.instructions}`, { indent: 14, color: MUTED });
    w.space(4);
  });
  if (doc.advice) {
    w.space(6);
    w.text("Advice", { size: 12, bold: true, gap: 2 });
    for (const line of doc.advice.split(/\r?\n/).filter((l) => l.trim())) w.text(line);
  }
  if (doc.follow_up) {
    w.space(6);
    w.text("Follow-up", { size: 12, bold: true, gap: 2 });
    for (const line of doc.follow_up.split(/\r?\n/).filter((l) => l.trim())) w.text(line);
  }

  w.footer([
    `${p.name} - ${registrationLine(p)}`,
    `${signatureLine(doc)}.`,
    `Content hash (SHA-256): ${contentHash}`,
    `${AI_NOTE} ${GENERATED_BY}.`,
  ]);
  return pdf.save({ useObjectStreams: false });
}
