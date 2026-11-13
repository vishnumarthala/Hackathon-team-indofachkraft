// Ticket 047: import existing children from a CSV (server only). Preview validates; import creates children, cases,
// therapist assignments and claim codes in one transaction with a strict `children.imported` audit row (counts only,
// no names). Idempotent by file hash per organisation. The file itself is never stored (NFR-1). Nothing is sent to
// families (NFR-2): the result lists codes and WhatsApp links for the centre to share.
import { createHash } from "node:crypto";
import { auditStrict, type SessionAuditActor } from "@/lib/audit";
import { requireProviderApi, type Actor } from "@/lib/authz";
import { isUuid } from "@/lib/cases/validation";
import { CLAIM_CODE_TTL_HOURS, claimMessage, generateClaimCode, hashClaimCode, normalizeClaimCode, todayInIndia } from "@/lib/children/codes";
import { env } from "@/lib/env";
import { fail } from "@/lib/http";
import { whatsappUrl } from "@/lib/intake/message";
import { canManage, getMembershipRole } from "@/lib/orgs";
import { pg, type Queryable } from "@/lib/pg";
import { decodeUtf8, MAX_FILE_BYTES } from "./csv";
import { defaultSeriesScheduler, seriesTablesExist, type SeriesScheduler } from "./timetable";
import {
  issue,
  parseDateOfBirth,
  parseImportText,
  rowsToImport,
  summarise,
  validateRows,
  type ExistingChild,
  type ImportRow,
  type ImportSummary,
  type Issue,
  type Member,
  type ParsedFile,
  type Service,
} from "./validate";

if (typeof window !== "undefined") {
  throw new Error("lib/import/store.ts is server-only");
}

export const ONLY_MANAGERS = "Only organisation owners and admins can import children";
export const ORG_NOT_FOUND = "Organisation not found";
export const IMPORT_NOT_FOUND = "Import not found";

// ---------- authorisation ----------

/** Owner/admin of `orgId`: null when allowed. Not a member (or a malformed id) -> 404; member -> 403. */
export async function checkImportManager(userId: string, orgId: string | null | undefined): Promise<Response | null> {
  if (!orgId || !isUuid(orgId)) return fail(404, ORG_NOT_FOUND);
  const role = await getMembershipRole(userId, orgId);
  if (!role) return fail(404, ORG_NOT_FOUND);
  if (!canManage(role)) return fail(403, ONLY_MANAGERS);
  return null;
}

/** Owner/admin of the import's organisation. Other tenants' and malformed ids -> 404; members -> 403. */
export async function requireImportAccess(
  importId: string,
): Promise<{ actor: Actor; orgId: string; importId: string } | { response: Response }> {
  const gate = await requireProviderApi();
  if ("response" in gate) return gate;
  if (!isUuid(importId)) return { response: fail(404, IMPORT_NOT_FOUND) };
  const sql = await pg();
  const [row] = await sql<{ org_id: string }[]>`select org_id from public.child_imports where id = ${importId}`;
  const role = row ? await getMembershipRole(gate.actor.user.id, row.org_id) : null;
  if (!row || !role) return { response: fail(404, IMPORT_NOT_FOUND) };
  if (!canManage(role)) return { response: fail(403, ONLY_MANAGERS) };
  return { actor: gate.actor, orgId: row.org_id, importId };
}

// ---------- upload ----------

export type Upload = { orgId: string | null; bytes: Uint8Array; importDuplicates: Set<number> };

/** multipart/form-data: `org_id`, `file` (<= 1 MB) and optional `import_duplicates` (JSON array of row numbers). */
export async function readUpload(req: Request): Promise<Upload | { response: Response }> {
  const length = Number(req.headers.get("content-length") ?? "0");
  if (length > MAX_FILE_BYTES + 64 * 1024) return { response: fail(413, issue("too_large").message, { file: issue("too_large") }) };
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return { response: fail(400, "Invalid request", { body: "Send the file as multipart/form-data" }) };
  }
  const orgId = form.get("org_id");
  const file = form.get("file");
  if (!(file instanceof Blob)) return { response: fail(400, "Invalid request", { file: "Choose a CSV file" }) };
  if (file.size > MAX_FILE_BYTES) return { response: fail(413, issue("too_large").message, { file: issue("too_large") }) };
  const importDuplicates = new Set<number>();
  const rawChoice = form.get("import_duplicates");
  if (typeof rawChoice === "string" && rawChoice.trim() !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawChoice);
    } catch {
      parsed = null;
    }
    if (!Array.isArray(parsed) || !parsed.every((n) => Number.isInteger(n) && n >= 2 && n <= 100_000)) {
      return { response: fail(400, "Invalid request", { import_duplicates: "Send a list of row numbers" }) };
    }
    for (const n of parsed as number[]) importDuplicates.add(n);
  }
  return {
    orgId: typeof orgId === "string" ? orgId : null,
    bytes: new Uint8Array(await file.arrayBuffer()),
    importDuplicates,
  };
}

export function fileHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// ---------- validation context ----------

async function loadMembers(sql: Queryable, orgId: string): Promise<Map<string, Member>> {
  const rows = await sql<{ user_id: string; email: string | null; name: string | null }[]>`
    select m.user_id, lower(u.email) as email,
           coalesce(nullif(btrim(p.display_name), ''), nullif(btrim(pp.display_name), '')) as name
    from public.org_members m
    join auth.users u on u.id = m.user_id
    left join public.user_profiles p on p.id = m.user_id
    left join public.provider_profiles pp on pp.user_id = m.user_id
    where m.org_id = ${orgId} and m.status = 'active'`;
  const members = new Map<string, Member>();
  for (const r of rows) {
    if (r.email) members.set(r.email, { user_id: r.user_id, name: (r.name ?? r.email.split("@")[0]).slice(0, 120) });
  }
  return members;
}

async function loadServices(sql: Queryable, orgId: string): Promise<Service[]> {
  return sql<Service[]>`
    select s.id, s.name, pp.user_id as provider_user_id
    from public.services s join public.provider_profiles pp on pp.id = s.provider_profile_id
    where s.org_id = ${orgId} and s.active and s.mode in ('in_clinic', 'video')`;
}

async function loadExisting(sql: Queryable, orgId: string, dobs: string[]): Promise<ExistingChild[]> {
  if (dobs.length === 0) return [];
  return sql<ExistingChild[]>`
    select c.id as case_id, ch.display_name, ch.date_of_birth::text as date_of_birth, c.parent_phone as phone
    from public.cases c join public.children ch on ch.id = c.child_id
    where c.org_id = ${orgId} and ch.deleted_at is null and ch.date_of_birth = any (${dobs}::date[])`;
}

function candidateDobs(parsed: ParsedFile): string[] {
  const index = parsed.header.indexOf("date_of_birth");
  if (index === -1) return [];
  const out = new Set<string>();
  for (const r of parsed.records) {
    const dob = parseDateOfBirth(r.cells[index] ?? "");
    if (dob) out.add(dob);
  }
  return [...out];
}

export type PreparedImport = {
  fileHash: string;
  fileErrors: Issue[];
  fileWarnings: Issue[];
  rows: ImportRow[];
  summary: ImportSummary;
  hasTimetable: boolean;
  seriesAvailable: boolean;
  alreadyImported: { id: string; created_at: string } | null;
};

/** Decoding, header checks and per-row validation against the organisation (members, services, existing children). */
export async function prepareImport(sql: Queryable, orgId: string, bytes: Uint8Array): Promise<PreparedImport> {
  const hash = fileHash(bytes);
  const empty: PreparedImport = {
    fileHash: hash,
    fileErrors: [],
    fileWarnings: [],
    rows: [],
    summary: summarise([]),
    hasTimetable: false,
    seriesAvailable: false,
    alreadyImported: null,
  };
  if (bytes.byteLength > MAX_FILE_BYTES) return { ...empty, fileErrors: [issue("too_large")] };
  const text = decodeUtf8(bytes);
  if (text === null) return { ...empty, fileErrors: [issue("not_utf8")] };
  const parsed = parseImportText(text);
  const [previous] = await sql<{ id: string; created_at: Date }[]>`
    select id, created_at from public.child_imports where org_id = ${orgId} and file_hash = ${hash} and undone_at is null`;
  const alreadyImported = previous ? { id: previous.id, created_at: previous.created_at.toISOString() } : null;
  const fileLevel = { ...empty, fileErrors: parsed.fileErrors, fileWarnings: parsed.fileWarnings, hasTimetable: parsed.hasTimetable, alreadyImported };
  if (parsed.fileErrors.length > 0) return fileLevel;

  const [members, services, existing, seriesAvailable] = await Promise.all([
    loadMembers(sql, orgId),
    parsed.hasTimetable ? loadServices(sql, orgId) : Promise.resolve([] as Service[]),
    loadExisting(sql, orgId, candidateDobs(parsed)),
    parsed.hasTimetable ? seriesTablesExist(sql) : Promise.resolve(false),
  ]);
  const rows = validateRows(parsed, { today: todayInIndia(), members, services, existing, seriesAvailable });
  return { ...fileLevel, rows, summary: summarise(rows), seriesAvailable };
}

// ---------- import ----------

export type CodeItem = {
  row: number | null;
  case_id: string;
  child_id: string;
  child_name: string;
  guardian_name: string;
  guardian_phone: string | null;
  language: string;
  code: string;
  expires_at: string;
  message: string;
  whatsapp_url: string;
  paper_consent_path: string;
};

export type ImportRecord = {
  id: string;
  org_id: string;
  total_rows: number;
  imported_count: number;
  skipped_count: number;
  failed_count: number;
  timetable_pending_count: number;
  series_created_count: number;
  created_at: string;
  undo_until: string;
  undone_at: string | null;
  /** Not undone and still inside the 24 h window (database clock). */
  undo_open: boolean;
};

type ImportDbRow = Omit<ImportRecord, "created_at" | "undo_until" | "undone_at"> & {
  created_at: Date;
  undo_until: Date;
  undone_at: Date | null;
};

const IMPORT_COLUMNS = `id, org_id, total_rows, imported_count, skipped_count, failed_count, timetable_pending_count,
  series_created_count, created_at, undo_until, undone_at, (undone_at is null and now() < undo_until) as undo_open`;

function toRecord(row: ImportDbRow): ImportRecord {
  return {
    ...row,
    created_at: row.created_at.toISOString(),
    undo_until: row.undo_until.toISOString(),
    undone_at: row.undone_at ? row.undone_at.toISOString() : null,
  };
}

export function codeItem(
  c: { row: number | null; case_id: string; child_id: string; child_name: string; guardian_name: string; guardian_phone: string | null; language: string; therapist_name: string },
  code: string,
  expiresAt: string,
): CodeItem {
  const message = claimMessage(
    { parent_alias: c.guardian_name, therapist_name: c.therapist_name, child_alias: c.child_name },
    env.NEXT_PUBLIC_APP_URL,
    code,
  );
  return {
    row: c.row,
    case_id: c.case_id,
    child_id: c.child_id,
    child_name: c.child_name,
    guardian_name: c.guardian_name,
    guardian_phone: c.guardian_phone,
    language: c.language,
    code,
    expires_at: expiresAt,
    message,
    whatsapp_url: whatsappUrl(c.guardian_phone, message),
    paper_consent_path: `/cases/${c.case_id}/consent/paper`,
  };
}

export type ImportOutcome =
  | { result: "invalid"; prepared: PreparedImport }
  | { result: "nothing_to_import"; prepared: PreparedImport }
  | { result: "existing"; import: ImportRecord }
  | { result: "imported"; import: ImportRecord; items: CodeItem[]; prepared: PreparedImport };

/** FR-3: one transaction per file; a second upload of the same file returns the first import (no new rows). */
export async function runImport(input: {
  orgId: string;
  actor: SessionAuditActor & { actorUserId: string };
  bytes: Uint8Array;
  importDuplicates: ReadonlySet<number>;
  scheduler?: SeriesScheduler;
}): Promise<ImportOutcome> {
  const { orgId, actor, bytes, importDuplicates } = input;
  const scheduler = input.scheduler ?? defaultSeriesScheduler;
  const hash = fileHash(bytes);
  const sql = await pg();
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${`child_import:${orgId}`}, 0))`;
    const [previous] = await tx<ImportDbRow[]>`
      select ${tx.unsafe(IMPORT_COLUMNS)} from public.child_imports
      where org_id = ${orgId} and file_hash = ${hash} and undone_at is null`;
    if (previous) return { result: "existing", import: toRecord(previous) } as const;

    const prepared = await prepareImport(tx, orgId, bytes);
    if (prepared.fileErrors.length > 0) return { result: "invalid", prepared } as const;
    const create = rowsToImport(prepared.rows, importDuplicates);
    if (create.length === 0) return { result: "nothing_to_import", prepared } as const;
    const failed = prepared.rows.filter((r) => r.status === "error").length;
    const skipped = prepared.rows.length - failed - create.length;

    const [org] = await tx<{ name: string }[]>`select name from public.organizations where id = ${orgId}`;
    const [imp] = await tx<{ id: string }[]>`
      insert into public.child_imports (org_id, file_hash, total_rows, imported_count, skipped_count, failed_count, created_by)
      values (${orgId}, ${hash}, ${prepared.rows.length}, ${create.length}, ${skipped}, ${failed}, ${actor.actorUserId})
      returning id`;

    const codes = new Map<number, string>();
    const payload = create.map((r) => {
      const code = generateClaimCode();
      codes.set(r.row, code);
      return {
        row_number: r.row,
        display_name: r.display_name,
        date_of_birth: r.date_of_birth,
        child_age_months: r.child_age_months,
        guardian_name: r.guardian_name,
        guardian_phone: r.guardian_phone,
        language: r.language,
        therapist_user_id: r.therapist_user_id,
        therapist_name: (r.therapist_name ?? org?.name ?? "Your centre").slice(0, 120),
        notes: r.notes,
        code_hash: hashClaimCode(normalizeClaimCode(code) as string),
        timetable: r.timetable,
      };
    });
    const [{ created }] = await tx<{ created: { row_number: number; child_id: string; case_id: string; expires_at: string }[] }[]>`
      select public.import_children_rows(${imp.id}::uuid, ${orgId}::uuid, ${actor.actorUserId}::uuid,
        ${tx.json(payload as unknown as Parameters<typeof tx.json>[0])}::jsonb, ${`${CLAIM_CODE_TTL_HOURS} hours`}::interval) as created`;

    // Optional timetable (043): scheduled when weekly series exist, otherwise kept as `pending`.
    let seriesCreated = 0;
    const withTimetable = create.filter((r) => r.timetable);
    if (withTimetable.length > 0 && (await scheduler.available(tx))) {
      for (const r of withTimetable) {
        const made = created.find((c) => c.row_number === r.row);
        if (!made || !r.timetable || !r.therapist_user_id) continue;
        const seriesId = await scheduler.create(tx, {
          orgId,
          childId: made.child_id,
          caseId: made.case_id,
          therapistUserId: r.therapist_user_id,
          serviceId: r.timetable.service_id,
          weekdays: r.timetable.weekdays,
          time: r.timetable.time,
          createdBy: actor.actorUserId,
        });
        if (seriesId) {
          seriesCreated += 1;
          await tx`update public.child_import_rows set timetable_status = 'scheduled', series_id = ${seriesId}
                   where import_id = ${imp.id} and row_number = ${r.row}`;
        }
      }
    }
    const [record] = await tx<ImportDbRow[]>`
      update public.child_imports
      set timetable_pending_count = ${withTimetable.length - seriesCreated}, series_created_count = ${seriesCreated}
      where id = ${imp.id}
      returning ${tx.unsafe(IMPORT_COLUMNS)}`;

    // Counts only: no names, phones or notes in the audit payload (FR-3).
    await auditStrict(
      {
        ...actor,
        orgId,
        action: "children.imported",
        entity: "child_import",
        entityId: imp.id,
        details: {
          import_id: imp.id,
          total_rows: prepared.rows.length,
          imported: create.length,
          skipped,
          failed,
          timetable_pending: withTimetable.length - seriesCreated,
          series_created: seriesCreated,
        },
      },
      tx,
    );

    const byRow = new Map(create.map((r) => [r.row, r]));
    const items = created.map((c) => {
      const r = byRow.get(c.row_number) as ImportRow;
      return codeItem(
        {
          row: r.row,
          case_id: c.case_id,
          child_id: c.child_id,
          child_name: r.display_name,
          guardian_name: r.guardian_name,
          guardian_phone: r.guardian_phone,
          language: r.language,
          therapist_name: (r.therapist_name ?? org?.name ?? "Your centre").slice(0, 120),
        },
        codes.get(c.row_number) as string,
        new Date(c.expires_at).toISOString(),
      );
    });
    return { result: "imported", import: toRecord(record), items, prepared } as const;
  });
}

// ---------- undo (FR-5) ----------

export type UndoOutcome =
  | { result: "undone"; cases: number; children: number }
  | { result: "blocked"; blocked_rows: number[] }
  | { result: "expired" | "already_undone" | "not_found" };

export async function undoImport(importId: string, actor: SessionAuditActor & { actorUserId: string }): Promise<UndoOutcome> {
  const sql = await pg();
  return sql.begin(async (tx) => {
    const [{ outcome }] = await tx<{ outcome: UndoOutcome & { org_id?: string } }[]>`
      select public.undo_child_import(${importId}::uuid, ${actor.actorUserId}::uuid) as outcome`;
    if (outcome.result === "undone") {
      await auditStrict(
        {
          ...actor,
          orgId: outcome.org_id ?? null,
          action: "children.import_undone",
          entity: "child_import",
          entityId: importId,
          details: { import_id: importId, cases: outcome.cases, children: outcome.children },
        },
        tx,
      );
      return { result: "undone", cases: outcome.cases, children: outcome.children };
    }
    return outcome;
  });
}

// ---------- reading ----------

export async function listImports(orgId: string, limit = 20): Promise<ImportRecord[]> {
  const sql = await pg();
  const rows = await sql<ImportDbRow[]>`
    select ${sql.unsafe(IMPORT_COLUMNS)} from public.child_imports where org_id = ${orgId}
    order by created_at desc limit ${limit}`;
  return rows.map(toRecord);
}

export async function getImport(importId: string): Promise<ImportRecord | null> {
  if (!isUuid(importId)) return null;
  const sql = await pg();
  const [row] = await sql<ImportDbRow[]>`select ${sql.unsafe(IMPORT_COLUMNS)} from public.child_imports where id = ${importId}`;
  return row ? toRecord(row) : null;
}

export type ImportedChild = {
  row: number;
  case_id: string;
  child_id: string;
  child_name: string;
  date_of_birth: string | null;
  guardian_name: string;
  guardian_phone: string | null;
  language: string;
  therapist_name: string;
  notes: string | null;
  timetable: { weekdays: number[]; time: string; service_name: string } | null;
  timetable_status: "pending" | "scheduled" | null;
  guardian_linked: boolean;
  /** At least one consent currently granted (never set by the import itself). */
  consent_given: boolean;
  code_expires_at: string | null;
};

export async function listImportedChildren(importId: string): Promise<ImportedChild[]> {
  const sql = await pg();
  const rows = await sql<(Omit<ImportedChild, "code_expires_at"> & { code_expires_at: Date | null })[]>`
    select ir.row_number as row, ir.case_id, ir.child_id, c.child_alias as child_name,
           ch.date_of_birth::text as date_of_birth, c.parent_alias as guardian_name, c.parent_phone as guardian_phone,
           c.language, c.therapist_name, ir.notes, ir.timetable, ir.timetable_status,
           exists (select 1 from public.guardian_links gl where gl.child_id = ir.child_id and gl.status = 'active') as guardian_linked,
           exists (select 1 from public.child_consent_state s where s.child_id = ir.child_id and s.granted) as consent_given,
           (select max(cc.expires_at) from public.child_claim_codes cc
             where cc.case_id = ir.case_id and cc.used_at is null and cc.expires_at > now()) as code_expires_at
    from public.child_import_rows ir
    join public.cases c on c.id = ir.case_id
    join public.children ch on ch.id = ir.child_id
    where ir.import_id = ${importId}
    order by ir.row_number`;
  return rows.map((r) => ({ ...r, code_expires_at: r.code_expires_at ? r.code_expires_at.toISOString() : null }));
}

/** FR-3 "regenerable": new codes (older unused ones stop working) for imported children no guardian has claimed. */
export async function regenerateCodes(importId: string, userId: string): Promise<CodeItem[]> {
  const children = (await listImportedChildren(importId)).filter((c) => !c.guardian_linked);
  if (children.length === 0) return [];
  const sql = await pg();
  return sql.begin(async (tx) => {
    const items: CodeItem[] = [];
    for (const c of children) {
      const code = generateClaimCode();
      const [{ stored }] = await tx<{ stored: { expires_at: string } }[]>`
        select public.create_child_claim_code(${c.case_id}::uuid, ${hashClaimCode(normalizeClaimCode(code) as string)},
          ${userId}::uuid, ${`${CLAIM_CODE_TTL_HOURS} hours`}::interval) as stored`;
      items.push(
        codeItem(
          {
            row: c.row,
            case_id: c.case_id,
            child_id: c.child_id,
            child_name: c.child_name,
            guardian_name: c.guardian_name,
            guardian_phone: c.guardian_phone,
            language: c.language,
            therapist_name: c.therapist_name,
          },
          code,
          new Date(stored.expires_at).toISOString(),
        ),
      );
    }
    return items;
  });
}

/** The preview as JSON (names stay in the response only; nothing is stored). */
export function previewJson(prepared: PreparedImport) {
  return {
    file_hash: prepared.fileHash,
    file_errors: prepared.fileErrors,
    file_warnings: prepared.fileWarnings,
    summary: prepared.summary,
    has_timetable: prepared.hasTimetable,
    series_available: prepared.seriesAvailable,
    already_imported: prepared.alreadyImported,
    rows: prepared.rows.map((r) => ({
      row: r.row,
      status: r.status,
      child_name: r.display_name,
      date_of_birth: r.date_of_birth,
      age_years: r.age_years,
      guardian_name: r.guardian_name,
      guardian_phone: r.guardian_phone,
      language: r.language,
      therapist_email: r.therapist_email,
      timetable: r.timetable ? { weekdays: r.timetable.weekdays, time: r.timetable.time, service_name: r.timetable.service_name } : null,
      errors: r.errors,
      warnings: r.warnings,
      duplicate_of: r.duplicate_of,
    })),
  };
}

export type PreviewJson = ReturnType<typeof previewJson>;
