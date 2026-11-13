// Ticket 047 FR-1/FR-2: CSV columns, per-row validation and duplicate detection (pure; unit tested). The server
// re-runs this on every preview and import; nothing the browser sends about validity is trusted.
import en from "@/messages/en.json";
import { ageParts } from "@/lib/children/codes";
import { normalizeIndianMobile } from "@/lib/family/phone";
import { createTranslator } from "@/lib/i18n/translate";
import { CsvSyntaxError, MAX_ROWS, parseCsv } from "./csv";
import { parseBillingMode, parseTime, parseWeekdays, type ImportBillingMode, type Timetable } from "./timetable";

export const REQUIRED_COLUMNS = ["child_first_name", "date_of_birth", "guardian_name"] as const;
export const OPTIONAL_COLUMNS = [
  "child_last_name",
  "guardian_phone",
  "preferred_language",
  "therapist_email",
  "notes",
] as const;
/** `billing_mode` (044): 043's package / per_session / free, empty = per_session. */
export const TIMETABLE_COLUMNS = ["weekdays", "time", "service_name", "billing_mode"] as const;
/** Template order (FR-1). */
export const TEMPLATE_COLUMNS = [
  "child_first_name",
  "child_last_name",
  "date_of_birth",
  "guardian_name",
  "guardian_phone",
  "preferred_language",
  "therapist_email",
  "notes",
  ...TIMETABLE_COLUMNS,
] as const;
export type Column = (typeof TEMPLATE_COLUMNS)[number];

export const NAME_MAX = 60;
export const NOTES_MAX = 500;
/** Ages above this get a warning (decision 11: up to 8 years). */
export const AGE_WARNING_YEARS = 8;
/** 18 or older is refused: DoctorNearMe's children's records are for minors. */
export const AGE_LIMIT_YEARS = 18;

export type IssueCode =
  // file
  | "not_utf8"
  | "too_large"
  | "empty"
  | "too_many_rows"
  | "missing_columns"
  | "duplicate_columns"
  | "csv_syntax"
  | "unknown_columns"
  // row errors
  | "name_required"
  | "name_too_long"
  | "dob_required"
  | "dob_invalid"
  | "dob_future"
  | "dob_too_old"
  | "guardian_required"
  | "guardian_too_long"
  | "phone_invalid"
  | "language_invalid"
  | "therapist_invalid_email"
  | "therapist_unknown"
  | "notes_too_long"
  | "extra_cells"
  | "timetable_incomplete"
  | "timetable_needs_therapist"
  | "weekdays_invalid"
  | "time_invalid"
  | "service_unknown"
  | "billing_mode_invalid"
  // row warnings
  | "age_over_8"
  | "phone_missing"
  | "duplicate_existing"
  | "duplicate_in_file"
  | "timetable_pending";

export type IssueParams = Record<string, string | number>;
export type Issue = { code: IssueCode; params: IssueParams; message: string };

const tIssue = createTranslator("en", en, "childImport.issues");

/** Plain English message (API responses, logs-free); the UI translates `code` + `params` itself. */
export function issue(code: IssueCode, params: IssueParams = {}): Issue {
  return { code, params, message: tIssue(code, params) };
}

export type Language = "en" | "hi" | "te";

export type Member = { user_id: string; name: string };
export type Service = { id: string; name: string; provider_user_id: string | null };
export type ExistingChild = { case_id: string; display_name: string; date_of_birth: string; phone: string | null };

export type ValidationContext = {
  /** Today in India, YYYY-MM-DD. */
  today: string;
  /** Active org members by lower-case email. */
  members: Map<string, Member>;
  services: Service[];
  /** Children of the org's cases (for FR-2 duplicates). */
  existing: ExistingChild[];
  /** 043 weekly series exist in this database. */
  seriesAvailable: boolean;
};

export type RowTimetable = Timetable & { service_id: string; service_name: string; billing_mode: ImportBillingMode };

export type ImportRow = {
  /** Spreadsheet row number (header = 1). */
  row: number;
  status: "valid" | "error" | "duplicate";
  child_first_name: string;
  child_last_name: string;
  display_name: string;
  date_of_birth: string | null;
  age_years: number | null;
  child_age_months: number | null;
  guardian_name: string;
  guardian_phone: string | null;
  language: Language;
  therapist_email: string | null;
  therapist_user_id: string | null;
  therapist_name: string | null;
  notes: string | null;
  timetable: RowTimetable | null;
  errors: Issue[];
  warnings: Issue[];
  duplicate_of: { kind: "existing"; case_id: string } | { kind: "file"; row: number } | null;
};

export type ParsedFile = {
  fileErrors: Issue[];
  fileWarnings: Issue[];
  /** Normalised header names, in file order. */
  header: string[];
  /** Data records with their spreadsheet row numbers (blank lines dropped). */
  records: { row: number; cells: string[] }[];
  hasTimetable: boolean;
};

export function normaliseHeader(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\*/g, "")
    .trim()
    .replace(/[\s-]+/g, "_");
}

/** FR-1: header checks, row limit and blank-line handling. */
export function parseImportText(text: string): ParsedFile {
  const result: ParsedFile = { fileErrors: [], fileWarnings: [], header: [], records: [], hasTimetable: false };
  let records: string[][];
  try {
    records = parseCsv(text);
  } catch (err) {
    if (err instanceof CsvSyntaxError) {
      result.fileErrors.push(issue("csv_syntax", { row: err.record }));
      return result;
    }
    throw err;
  }
  const isBlank = (cells: string[]) => cells.every((c) => c.trim() === "");
  const headerIndex = records.findIndex((cells) => !isBlank(cells));
  if (headerIndex === -1) {
    result.fileErrors.push(issue("empty"));
    return result;
  }
  result.header = records[headerIndex].map(normaliseHeader);
  const seen = new Set<string>();
  for (const name of result.header) {
    if (name && seen.has(name)) result.fileErrors.push(issue("duplicate_columns", { column: name }));
    seen.add(name);
  }
  const missing = REQUIRED_COLUMNS.filter((c) => !seen.has(c));
  if (missing.length > 0) result.fileErrors.push(issue("missing_columns", { columns: missing.join(", ") }));
  const known = new Set<string>(TEMPLATE_COLUMNS);
  const unknown = result.header.filter((h) => h && !known.has(h));
  if (unknown.length > 0) result.fileWarnings.push(issue("unknown_columns", { columns: unknown.join(", ") }));
  result.hasTimetable = TIMETABLE_COLUMNS.some((c) => seen.has(c));

  result.records = records
    .map((cells, index) => ({ row: index + 1, cells }))
    .slice(headerIndex + 1)
    .filter((r) => !isBlank(r.cells));
  if (result.records.length === 0) result.fileErrors.push(issue("empty"));
  if (result.records.length > MAX_ROWS) {
    result.fileErrors.push(issue("too_many_rows", { count: result.records.length, max: MAX_ROWS }));
  }
  return result;
}

function isValidDate(y: number, m: number, d: number): boolean {
  if (y < 1900 || m < 1 || m > 12 || d < 1) return false;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** FR-1: YYYY-MM-DD or DD/MM/YYYY (also D/M/YYYY, DD-MM-YYYY, DD.MM.YYYY). ISO date or null. */
export function parseDateOfBirth(value: string): string | null {
  const v = value.trim();
  let y: number, m: number, d: number;
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(v);
  if (match) [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  else {
    match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(v);
    if (!match) return null;
    [d, m, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
  }
  return isValidDate(y, m, d) ? `${y}-${pad(m)}-${pad(d)}` : null;
}

const LANGUAGE_ALIASES: Record<string, Language> = {
  en: "en",
  english: "en",
  hi: "hi",
  hindi: "hi",
  "हिन्दी": "hi",
  "हिंदी": "hi",
  te: "te",
  telugu: "te",
  "తెలుగు": "te",
};

export function parseLanguage(value: string): Language | null {
  const v = value.trim().toLowerCase();
  if (v === "") return "en";
  return LANGUAGE_ALIASES[v] ?? null;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const clean = (value: string | undefined) => (value ?? "").normalize("NFC").replace(/\s+/g, " ").trim();

/** First-name + date of birth + phone key (FR-2). */
export function duplicateKey(firstName: string, dateOfBirth: string, phone: string | null): string {
  return `${firstName.normalize("NFC").trim().toLocaleLowerCase()}|${dateOfBirth}|${phone ? (normalizeIndianMobile(phone) ?? phone) : ""}`;
}

/** An existing child matches when its name starts with the first name (as a whole word), same DOB and phone. */
function matchesExisting(row: { first: string; dob: string; phone: string | null }, child: ExistingChild): boolean {
  if (child.date_of_birth !== row.dob) return false;
  const a = row.phone ? normalizeIndianMobile(row.phone) : null;
  const b = child.phone ? normalizeIndianMobile(child.phone) ?? child.phone.replace(/\D/g, "") : null;
  if ((a ?? "") !== (b ?? "")) return false;
  const name = child.display_name.normalize("NFC").trim().toLocaleLowerCase();
  const first = row.first.normalize("NFC").trim().toLocaleLowerCase();
  return name === first || name.startsWith(`${first} `);
}

function pickService(services: Service[], name: string, therapistUserId: string | null): Service | null {
  const wanted = name.trim().toLocaleLowerCase();
  const matches = services.filter((s) => s.name.trim().toLocaleLowerCase() === wanted);
  return matches.find((s) => s.provider_user_id === therapistUserId) ?? matches[0] ?? null;
}

/** FR-2: every data row validated on its own; duplicates flagged against the org and earlier rows of the file. */
export function validateRows(parsed: ParsedFile, ctx: ValidationContext): ImportRow[] {
  const col = new Map(parsed.header.map((name, index) => [name, index] as const));
  const today = new Date(`${ctx.today}T00:00:00Z`);
  const seenKeys = new Map<string, number>();

  return parsed.records.map(({ row, cells }) => {
    const get = (name: Column) => {
      const index = col.get(name);
      return index === undefined ? "" : clean(cells[index]);
    };
    const errors: Issue[] = [];
    const warnings: Issue[] = [];

    if (cells.slice(parsed.header.length).some((c) => c.trim() !== "")) errors.push(issue("extra_cells", { row }));

    const first = get("child_first_name");
    const last = get("child_last_name");
    const displayName = `${first} ${last}`.trim();
    if (!first) errors.push(issue("name_required", { row }));
    else if (displayName.length > NAME_MAX) errors.push(issue("name_too_long", { row, max: NAME_MAX }));

    const dobRaw = get("date_of_birth");
    const dob = dobRaw ? parseDateOfBirth(dobRaw) : null;
    let ageYears: number | null = null;
    let ageMonths: number | null = null;
    if (!dobRaw) errors.push(issue("dob_required", { row }));
    else if (!dob) errors.push(issue("dob_invalid", { row, value: dobRaw }));
    else if (dob > ctx.today) errors.push(issue("dob_future", { row }));
    else {
      const parts = ageParts(dob, today);
      if (parts) {
        ageYears = parts.years;
        const total = parts.years * 12 + parts.months;
        ageMonths = total >= 12 && total <= 216 ? total : null;
        if (parts.years >= AGE_LIMIT_YEARS) errors.push(issue("dob_too_old", { row }));
        else if (parts.years > AGE_WARNING_YEARS) warnings.push(issue("age_over_8", { row, years: parts.years }));
      }
    }

    const guardian = get("guardian_name");
    if (!guardian) errors.push(issue("guardian_required", { row }));
    else if (guardian.length > NAME_MAX) errors.push(issue("guardian_too_long", { row, max: NAME_MAX }));

    const phoneRaw = get("guardian_phone");
    let phone: string | null = null;
    if (phoneRaw) {
      const normalised = normalizeIndianMobile(phoneRaw);
      if (normalised) phone = `+${normalised}`;
      else errors.push(issue("phone_invalid", { row, value: phoneRaw }));
    } else warnings.push(issue("phone_missing", { row }));

    const languageRaw = get("preferred_language");
    const language = parseLanguage(languageRaw);
    if (!language) errors.push(issue("language_invalid", { row, value: languageRaw }));

    const emailRaw = get("therapist_email").toLowerCase();
    let therapist: Member | null = null;
    if (emailRaw) {
      if (!EMAIL.test(emailRaw)) errors.push(issue("therapist_invalid_email", { row, value: emailRaw }));
      else {
        therapist = ctx.members.get(emailRaw) ?? null;
        if (!therapist) errors.push(issue("therapist_unknown", { row }));
      }
    }

    const notes = (cells[col.get("notes") ?? -1] ?? "").normalize("NFC").trim();
    if (notes.length > NOTES_MAX) errors.push(issue("notes_too_long", { row, max: NOTES_MAX }));

    let timetable: RowTimetable | null = null;
    const [weekdaysRaw, timeRaw, serviceRaw, billingRaw] = [get("weekdays"), get("time"), get("service_name"), get("billing_mode")];
    if (weekdaysRaw || timeRaw || serviceRaw || billingRaw) {
      if (!weekdaysRaw || !timeRaw || !serviceRaw) errors.push(issue("timetable_incomplete", { row }));
      else {
        const weekdays = parseWeekdays(weekdaysRaw);
        const time = parseTime(timeRaw);
        const billing = parseBillingMode(billingRaw);
        if (!weekdays) errors.push(issue("weekdays_invalid", { row, value: weekdaysRaw }));
        if (!time) errors.push(issue("time_invalid", { row, value: timeRaw }));
        if (!billing) errors.push(issue("billing_mode_invalid", { row, value: billingRaw }));
        if (!emailRaw) errors.push(issue("timetable_needs_therapist", { row }));
        const service = pickService(ctx.services, serviceRaw, therapist?.user_id ?? null);
        if (!service) errors.push(issue("service_unknown", { row, value: serviceRaw }));
        if (weekdays && time && service && billing) {
          timetable = { weekdays, time, service_id: service.id, service_name: service.name, billing_mode: billing };
        }
      }
    }

    let duplicateOf: ImportRow["duplicate_of"] = null;
    if (first && dob) {
      const key = duplicateKey(first, dob, phone);
      const earlier = seenKeys.get(key);
      const existing = ctx.existing.find((c) => matchesExisting({ first, dob, phone }, c));
      if (existing) {
        duplicateOf = { kind: "existing", case_id: existing.case_id };
        warnings.push(issue("duplicate_existing", { row }));
      } else if (earlier !== undefined) {
        duplicateOf = { kind: "file", row: earlier };
        warnings.push(issue("duplicate_in_file", { row, other: earlier }));
      }
      if (earlier === undefined && errors.length === 0) seenKeys.set(key, row);
    }

    if (timetable && errors.length === 0 && !ctx.seriesAvailable) warnings.push(issue("timetable_pending", { row }));

    return {
      row,
      status: errors.length > 0 ? "error" : duplicateOf ? "duplicate" : "valid",
      child_first_name: first,
      child_last_name: last,
      display_name: displayName,
      date_of_birth: dob,
      age_years: ageYears,
      child_age_months: ageMonths,
      guardian_name: guardian,
      guardian_phone: phone,
      language: language ?? "en",
      therapist_email: emailRaw || null,
      therapist_user_id: therapist?.user_id ?? null,
      therapist_name: therapist?.name ?? null,
      notes: notes || null,
      timetable,
      errors,
      warnings,
      duplicate_of: duplicateOf,
    } satisfies ImportRow;
  });
}

export type ImportSummary = { total: number; valid: number; errors: number; duplicates: number; warnings: number };

export function summarise(rows: ImportRow[]): ImportSummary {
  return {
    total: rows.length,
    valid: rows.filter((r) => r.status === "valid").length,
    errors: rows.filter((r) => r.status === "error").length,
    duplicates: rows.filter((r) => r.status === "duplicate").length,
    warnings: rows.filter((r) => r.warnings.length > 0).length,
  };
}

/** Rows the import creates: valid rows plus the duplicates the user chose to `Import anyway`. */
export function rowsToImport(rows: ImportRow[], importDuplicates: ReadonlySet<number>): ImportRow[] {
  return rows.filter((r) => r.status === "valid" || (r.status === "duplicate" && importDuplicates.has(r.row)));
}
