// Ticket 047: a small RFC 4180 CSV reader/writer (pure, client- and server-safe). Quoted fields may contain the
// delimiter, quotes ("") and line breaks. Excel and Google Sheets exports (CRLF, UTF-8 BOM, `;` delimiter in some
// locales) are accepted.

export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_ROWS = 500;

export class CsvSyntaxError extends Error {
  constructor(readonly record: number) {
    super(`Unclosed quote in row ${record}`);
    this.name = "CsvSyntaxError";
  }
}

/** UTF-8 only (Telugu/Hindi names): invalid byte sequences give null. A leading BOM is removed. */
export function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  } catch {
    return null;
  }
}

/** `,` unless the header line has no comma but has semicolons (European Excel). */
export function detectDelimiter(text: string): "," | ";" {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  return !firstLine.includes(",") && firstLine.includes(";") ? ";" : ",";
}

/** Records as arrays of raw cell strings. Throws CsvSyntaxError for an unclosed quote. */
export function parseCsv(text: string, delimiter: "," | ";" = detectDelimiter(text)): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let inQuotes = false;
  let fieldStarted = false;
  let i = 0;
  const pushField = () => {
    record.push(field);
    field = "";
    fieldStarted = false;
  };
  const pushRecord = () => {
    pushField();
    records.push(record);
    record = [];
  };
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 2;
      } else if (ch === '"') {
        inQuotes = false;
        i += 1;
      } else {
        field += ch;
        i += 1;
      }
      continue;
    }
    if (ch === '"' && !fieldStarted) {
      inQuotes = true;
      fieldStarted = true;
      i += 1;
    } else if (ch === delimiter) {
      pushField();
      i += 1;
    } else if (ch === "\r" || ch === "\n") {
      pushRecord();
      i += ch === "\r" && text[i + 1] === "\n" ? 2 : 1;
    } else {
      field += ch;
      fieldStarted = true;
      i += 1;
    }
  }
  if (inQuotes) throw new CsvSyntaxError(records.length + 1);
  if (field !== "" || record.length > 0) pushRecord();
  return records;
}

// Spreadsheet apps run cells starting with = + - @ as formulas (CSV injection): prefix those with an apostrophe.
// Phone numbers such as "+91 90000 00001" (only digits and spaces after the sign) are left alone.
function neutralise(value: string): string {
  if (/^[=@\t\r]/.test(value)) return `'${value}`;
  if (/^[+-]/.test(value) && !/^[+-][\d ]*$/.test(value)) return `'${value}`;
  return value;
}

export function toCsv(rows: (string | number | null | undefined)[][]): string {
  return rows
    .map((row) =>
      row
        .map((cell) => {
          const value = neutralise(cell == null ? "" : String(cell));
          return /[",\r\n;]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
        })
        .join(","),
    )
    .join("\r\n");
}
