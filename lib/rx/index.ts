// Ticket 039: e-prescriptions for verified prescribers. Server only.
//
// Access: callers have passed a gate first (lib/rx/authz.ts): providers need case access (022) AND
// `provider_can_prescribe(own profile)` (028); guardians an active link to the child and a guardian-visible published
// version. Every write is one transaction that locks the prescription row and writes its audit row in the same
// transaction (`auditStrict(event, tx)`, 041).
//
// Signing (`signPrescription`, FR-4) in ONE transaction: re-checks `provider_can_prescribe` for the signer (profile row
// locked `for share`, so a concurrent suspension is ordered before or after the signature, never in between; the
// database trigger checks it again), compares item drug names with the child's allergies (021
// `getPrescribingHealthFacts`; `recorded: false` = UNKNOWN, never "none"), freezes the draft version with child /
// allergy / prescriber snapshots, `content_md` (authoritative) + sha256, publishes it to the guardian (024
// `publishVersion`, entity_type `prescription`), writes `rx.signed` (strict audit), enqueues `prescription.signed`
// (032 outbox; ids only) and stores the PDF in the private `prescriptions` bucket. Voiding (`voidPrescription`) needs a
// reason, creates no new prescription version, publishes a "cancelled" version for guardians and writes `rx.voided`.
import type postgres from "postgres";
import { auditStrict } from "@/lib/audit";
import { contentHash, publishVersion } from "@/lib/clinical/publish";
import { isUuid } from "@/lib/cases/validation";
import { supabaseAdmin } from "@/lib/db";
import { logger, errorMessage } from "@/lib/log";
import { enqueue } from "@/lib/notify/outbox";
import { pg as db } from "@/lib/pg";
import { getPrescribingHealthFacts } from "@/lib/queries/health";
import type { RxDraftContent } from "@/lib/scribe/schema";
import {
  ageOn,
  cancelledMarkdown,
  prescriptionMarkdown,
  type AllergiesSnapshot,
  type ChildSnapshot,
  type PrescriberSnapshot,
  type RxDocument,
} from "./document";
import { renderPrescriptionPdf } from "./pdf";
import { MSG, RxItemSchema, allergyMatches, signIssues, type AllergyMatch, type RxItem, type RxPatch, type RxStatus } from "./schema";

export const PRESCRIPTIONS_BUCKET = "prescriptions";

type Tx = postgres.Sql | postgres.TransactionSql;
const log = logger("rx");

export type Failure = { ok: false; status: 403 | 404 | 409 | 422; error: string; details?: Record<string, unknown> };
const fail = (status: Failure["status"], error: string, details?: Record<string, unknown>): Failure => ({
  ok: false,
  status,
  error,
  ...(details ? { details } : {}),
});

const iso = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));

// ---------------------------------------------------------------------------------------------------------
// Prescriber rule (028)

export type PrescriberProfile = {
  id: string;
  display_name: string;
  qualifications: string | null;
  provider_type: string;
  registration_council: string | null;
  registration_state: string | null;
  registration_number: string | null;
  can_prescribe: boolean;
};

/** The user's own provider profile with the derived 028 rule (`provider_can_prescribe`), or null. */
export async function prescriberProfileOf(userId: string, tx?: Tx, lock = false): Promise<PrescriberProfile | null> {
  const sql = tx ?? (await db());
  const rows = await sql<PrescriberProfile[]>`
    select p.id, p.display_name, p.qualifications, p.provider_type, p.registration_council, p.registration_state,
           p.registration_number, public.provider_can_prescribe(p.id) as can_prescribe
    from provider_profiles p where p.user_id = ${userId}
    ${lock ? sql`for share of p` : sql``}`;
  return rows[0] ?? null;
}

/** NFR-1: derived on the server every time; never stored, never read from the client. */
export async function userCanPrescribe(userId: string): Promise<boolean> {
  return (await prescriberProfileOf(userId))?.can_prescribe === true;
}

// ---------------------------------------------------------------------------------------------------------
// Reads

export type PrescriptionRow = {
  id: string;
  case_id: string;
  child_id: string;
  org_id: string;
  appointment_id: string | null;
  prescriber_profile_id: string;
  source_report_id: string | null;
  status: RxStatus;
  current_version: number;
  version: number;
  void_reason: string | null;
  voided_by: string | null;
  voided_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type VersionRow = {
  id: string;
  prescription_id: string;
  version: number;
  items: RxItem[];
  advice: string | null;
  follow_up: string | null;
  allergies_snapshot: AllergiesSnapshot | null;
  child_snapshot: ChildSnapshot | null;
  prescriber_snapshot: PrescriberSnapshot | null;
  content_md: string | null;
  content_hash: string | null;
  pdf_path: string | null;
  signed_by: string | null;
  signed_at: string | null;
};

export type PrescriptionSummary = {
  id: string;
  status: RxStatus;
  items: number;
  drugs: string[];
  prescriber_name: string;
  signed_at: string | null;
  voided_at: string | null;
  created_at: string;
  from_ai_draft: boolean;
};

export type PrescriptionDetail = {
  prescription: PrescriptionRow;
  current: VersionRow;
  prescriber_name: string;
};

function toPrescription(row: Record<string, unknown>): PrescriptionRow {
  return {
    ...(row as PrescriptionRow),
    voided_at: iso(row.voided_at),
    created_at: iso(row.created_at) as string,
    updated_at: iso(row.updated_at) as string,
  };
}

function toVersion(row: Record<string, unknown>): VersionRow {
  return {
    id: row.id as string,
    prescription_id: row.prescription_id as string,
    version: row.version as number,
    items: (row.items as RxItem[]) ?? [],
    advice: (row.advice as string | null) ?? null,
    follow_up: (row.follow_up as string | null) ?? null,
    allergies_snapshot: (row.allergies_snapshot as AllergiesSnapshot | null) ?? null,
    child_snapshot: (row.child_snapshot as ChildSnapshot | null) ?? null,
    prescriber_snapshot: (row.prescriber_snapshot as PrescriberSnapshot | null) ?? null,
    content_md: (row.content_md as string | null) ?? null,
    content_hash: (row.content_hash as string | null) ?? null,
    pdf_path: (row.pdf_path as string | null) ?? null,
    signed_by: (row.signed_by as string | null) ?? null,
    signed_at: iso(row.signed_at),
  };
}

async function loadPrescription(tx: Tx, id: string, lock = false): Promise<PrescriptionRow | null> {
  if (!isUuid(id)) return null;
  const rows = await tx<Record<string, unknown>[]>`
    select * from prescriptions where id = ${id} ${lock ? tx`for update` : tx``}`;
  return rows[0] ? toPrescription(rows[0]) : null;
}

async function loadVersion(tx: Tx, prescriptionId: string, version: number): Promise<VersionRow | null> {
  const rows = await tx<Record<string, unknown>[]>`
    select * from prescription_versions where prescription_id = ${prescriptionId} and version = ${version}`;
  return rows[0] ? toVersion(rows[0]) : null;
}

/** The case of a prescription (gates), or null for missing / malformed ids. */
export async function caseOfPrescription(id: string): Promise<string | null> {
  if (!isUuid(id)) return null;
  const sql = await db();
  const [row] = await sql<{ case_id: string }[]>`select case_id from prescriptions where id = ${id}`;
  return row?.case_id ?? null;
}

export async function listCasePrescriptions(caseId: string): Promise<PrescriptionSummary[]> {
  const sql = await db();
  const rows = await sql<
    {
      id: string;
      status: RxStatus;
      items: RxItem[];
      prescriber_name: string;
      signed_at: Date | null;
      voided_at: Date | null;
      created_at: Date;
      source_report_id: string | null;
    }[]
  >`
    select p.id, p.status, v.items, coalesce(v.prescriber_snapshot ->> 'name', pp.display_name) as prescriber_name,
           v.signed_at, p.voided_at, p.created_at, p.source_report_id
    from prescriptions p
    join prescription_versions v on v.prescription_id = p.id and v.version = p.current_version
    join provider_profiles pp on pp.id = p.prescriber_profile_id
    where p.case_id = ${caseId}
    order by p.created_at desc`;
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    items: r.items.length,
    drugs: r.items.map((i) => i.drug),
    prescriber_name: r.prescriber_name,
    signed_at: iso(r.signed_at),
    voided_at: iso(r.voided_at),
    created_at: iso(r.created_at) as string,
    from_ai_draft: r.source_report_id !== null,
  }));
}

export async function getPrescriptionDetail(id: string, caseId?: string): Promise<PrescriptionDetail | null> {
  const sql = await db();
  const prescription = await loadPrescription(sql, id);
  if (!prescription || (caseId && prescription.case_id !== caseId)) return null;
  const current = await loadVersion(sql, id, prescription.current_version);
  if (!current) return null;
  const [pp] = await sql<{ display_name: string }[]>`select display_name from provider_profiles where id = ${prescription.prescriber_profile_id}`;
  return { prescription, current, prescriber_name: current.prescriber_snapshot?.name ?? pp?.display_name ?? "" };
}

/** The case's open AI Rx draft (038) for the editor's "start from the AI draft" card. */
export async function getRxDraftReport(caseId: string, reportId: string): Promise<{ id: string; content: RxDraftContent } | null> {
  if (!isUuid(reportId)) return null;
  const sql = await db();
  const [row] = await sql<{ id: string; content: RxDraftContent }[]>`
    select id, content from reports where id = ${reportId} and case_id = ${caseId} and kind = 'rx_draft'`;
  return row ?? null;
}

/** Existing (not void) prescription started from a 038 Rx draft, if any. */
export async function prescriptionForReport(caseId: string, reportId: string): Promise<string | null> {
  if (!isUuid(reportId)) return null;
  const sql = await db();
  const [row] = await sql<{ id: string }[]>`
    select id from prescriptions where case_id = ${caseId} and source_report_id = ${reportId} and status <> 'void'
    order by created_at desc limit 1`;
  return row?.id ?? null;
}

// ---------------------------------------------------------------------------------------------------------
// Writes

/** 038 Rx draft items -> FR-2 items (citations dropped; items the schema rejects are left out). */
export function itemsFromDraft(content: Partial<RxDraftContent> | null | undefined): RxItem[] {
  const out: RxItem[] = [];
  for (const raw of content?.items ?? []) {
    const { citations: _citations, ...rest } = raw as RxDraftContent["items"][number];
    void _citations;
    const parsed = RxItemSchema.safeParse(rest);
    if (parsed.success) out.push(parsed.data);
  }
  return out.slice(0, 15);
}

/** FR-3: `POST /api/cases/:id/prescriptions` -> a draft, prefilled from a 038 `rx_draft` of the same case. */
export async function createPrescription(input: {
  caseId: string;
  actorUserId: string;
  profileId: string;
  fromReportId?: string;
}): Promise<{ ok: true; created: boolean; id: string } | Failure> {
  const sql = await db();
  return sql.begin(async (tx) => {
    const [kase] = await tx<{ id: string; child_id: string | null; org_id: string }[]>`
      select id, child_id, org_id from cases where id = ${input.caseId} for update`;
    if (!kase?.child_id) return fail(404, "Case not found");
    let items: RxItem[] = [];
    let advice: string | null = null;
    let followUp: string | null = null;
    if (input.fromReportId) {
      const [report] = await tx<{ id: string; content: RxDraftContent }[]>`
        select id, content from reports where id = ${input.fromReportId} and case_id = ${input.caseId} and kind = 'rx_draft'`;
      if (!report) return fail(404, MSG.draftNotFound);
      // The same AI draft opened twice continues the existing prescription instead of starting a second one.
      const [existing] = await tx<{ id: string }[]>`
        select id from prescriptions where case_id = ${input.caseId} and source_report_id = ${report.id} and status <> 'void'
        order by created_at desc limit 1`;
      if (existing) return { ok: true as const, created: false, id: existing.id };
      items = itemsFromDraft(report.content);
      advice = report.content?.advice?.slice(0, 2000) || null;
      followUp = report.content?.follow_up?.slice(0, 300) || null;
    }
    const [row] = await tx<{ id: string }[]>`
      insert into prescriptions (case_id, child_id, org_id, prescriber_profile_id, source_report_id, created_by)
      values (${kase.id}, ${kase.child_id}, ${kase.org_id}, ${input.profileId}, ${input.fromReportId ?? null}, ${input.actorUserId})
      returning id`;
    await tx`
      insert into prescription_versions (prescription_id, version, items, advice, follow_up)
      values (${row.id}, 1, ${tx.json(items as unknown as postgres.JSONValue)}, ${advice}, ${followUp})`;
    await auditStrict(
      {
        caseId: kase.id,
        actorUserId: input.actorUserId,
        action: "rx.draft_created",
        entity: "prescription",
        entityId: row.id,
        details: { from_report_id: input.fromReportId ?? null, items: items.length },
      },
      tx,
    );
    return { ok: true as const, created: true, id: row.id };
  });
}

/** FR-3: `PATCH /api/prescriptions/:id` `{ items, advice, follow_up, version }`; stale -> 409; signed/void -> 409. */
export async function updateDraft(input: {
  prescriptionId: string;
  actorUserId: string;
  body: RxPatch;
}): Promise<{ ok: true; version: number } | Failure> {
  const sql = await db();
  return sql.begin(async (tx) => {
    const rx = await loadPrescription(tx, input.prescriptionId, true);
    if (!rx) return fail(404, MSG.notFound);
    if (rx.status !== "draft") return fail(409, MSG.signedReadOnly);
    if (rx.version !== input.body.version) return fail(409, MSG.stale, { version: rx.version });
    await tx`
      update prescription_versions
      set items = ${tx.json(input.body.items as unknown as postgres.JSONValue)}, advice = ${input.body.advice},
          follow_up = ${input.body.follow_up}
      where prescription_id = ${rx.id} and version = ${rx.current_version}`;
    const [{ version }] = await tx<{ version: number }[]>`
      update prescriptions set version = version + 1, updated_at = now() where id = ${rx.id} returning version`;
    await auditStrict(
      {
        caseId: rx.case_id,
        actorUserId: input.actorUserId,
        action: "rx.draft_updated",
        entity: "prescription",
        entityId: rx.id,
        details: { items: input.body.items.length, version },
      },
      tx,
    );
    return { ok: true as const, version };
  });
}

export function pdfPathOf(rx: Pick<PrescriptionRow, "case_id" | "id">, version: number): string {
  return `${rx.case_id}/${rx.id}/v${version}.pdf`;
}

/** Rebuilds the document of a signed version from its stored snapshots (NFR-2). */
export function documentOf(v: VersionRow): RxDocument {
  if (!v.signed_at || !v.child_snapshot || !v.prescriber_snapshot || !v.allergies_snapshot) {
    throw new Error("prescription version is not signed");
  }
  return {
    child: v.child_snapshot,
    prescriber: v.prescriber_snapshot,
    allergies: v.allergies_snapshot,
    items: v.items,
    advice: v.advice,
    follow_up: v.follow_up,
    signed_at: v.signed_at,
    version: v.version,
  };
}

async function uploadPdf(path: string, bytes: Uint8Array): Promise<void> {
  const { error } = await supabaseAdmin()
    .storage.from(PRESCRIPTIONS_BUCKET)
    .upload(path, bytes, { contentType: "application/pdf", upsert: true });
  if (error) throw new Error(`Could not store the prescription PDF: ${error.message}`);
}

export type SignResult = {
  ok: true;
  version: VersionRow;
  published_version: number;
  matches: AllergyMatch[];
  event_ids: string[];
};

/** FR-4: sign the current draft version (one transaction). See the file header. */
export async function signPrescription(input: {
  prescriptionId: string;
  actorUserId: string;
  allergyOverrideReason: string | null;
}): Promise<SignResult | Failure> {
  const sql = await db();
  const probe = await loadPrescription(sql, input.prescriptionId);
  if (!probe) return fail(404, MSG.notFound);
  const facts = await getPrescribingHealthFacts(probe.child_id);
  let uploaded: string | null = null;
  try {
    return await sql.begin(async (tx) => {
      const rx = await loadPrescription(tx, input.prescriptionId, true);
      if (!rx) return fail(404, MSG.notFound);
      if (rx.status !== "draft") return fail(409, MSG.alreadySigned);
      // Health facts were read for this child; a claim merge in between re-points the case: ask for a retry.
      if (rx.child_id !== probe.child_id) return fail(409, MSG.stale, { version: rx.version });

      // NFR-1 / rule 9: the signer's own profile, re-checked now and locked against a concurrent suspension.
      const profile = await prescriberProfileOf(input.actorUserId, tx, true);
      if (!profile?.can_prescribe) return fail(403, MSG.notPrescriber);
      if (!profile.registration_council || !profile.registration_number) return fail(422, MSG.noRegistration);

      const draft = await loadVersion(tx, rx.id, rx.current_version);
      if (!draft) return fail(404, MSG.notFound);
      if (draft.items.length === 0) return fail(422, MSG.noItems);
      const issues = signIssues(draft.items);
      if (Object.keys(issues).length) return fail(422, MSG.incomplete, issues);

      const matches = allergyMatches(draft.items, facts.allergies);
      if (matches.length && !input.allergyOverrideReason) return fail(422, MSG.allergyMatch, { matches });

      const [child] = await tx<{ display_name: string; date_of_birth: string | null; child_age_months: number | null }[]>`
        select ch.display_name, ch.date_of_birth::text as date_of_birth, c.child_age_months
        from cases c join children ch on ch.id = c.child_id where c.id = ${rx.case_id}`;
      const [org] = await tx<{ name: string; address: string | null }[]>`
        select coalesce(o.public_name, o.name) as name,
               (select concat_ws(', ', l.address_line1, l.address_line2, l.locality, l.city || ' ' || l.pincode)
                from practice_locations l
                left join provider_locations pl on pl.location_id = l.id and pl.provider_profile_id = ${profile.id}
                where l.org_id = o.id
                order by (pl.location_id is null), l.created_at limit 1) as address
        from organizations o where o.id = ${rx.org_id}`;

      const signedAt = new Date();
      const doc: RxDocument = {
        child: {
          name: child.display_name,
          age: ageOn(child.date_of_birth, signedAt, child.child_age_months),
          date_of_birth: child.date_of_birth,
        },
        prescriber: {
          name: profile.display_name,
          qualifications: profile.qualifications,
          provider_type: profile.provider_type,
          council: profile.registration_council,
          council_state: profile.registration_state,
          registration_number: profile.registration_number,
          org: org.name,
          address: org.address,
        },
        allergies: {
          status: facts.allergies.length ? "listed" : facts.noKnownAllergies ? "none_known" : "not_recorded",
          allergies: facts.allergies.map((a) => ({ substance: a.substance, reaction: a.reaction ?? "", severity: a.severity ?? "unknown" })),
          medications: facts.medications.map((m) => ({ name: m.name, dose: m.dose, frequency: m.frequency })),
          health_profile_version: facts.version,
          matches,
          override_reason: matches.length ? input.allergyOverrideReason : null,
        },
        items: draft.items,
        advice: draft.advice,
        follow_up: draft.follow_up,
        signed_at: signedAt.toISOString(),
        version: draft.version,
      };
      const contentMd = prescriptionMarkdown(doc);
      const hash = contentHash(contentMd);
      const pdfPath = pdfPathOf(rx, draft.version);

      const [signed] = await tx<Record<string, unknown>[]>`
        update prescription_versions
        set allergies_snapshot = ${tx.json(doc.allergies as unknown as postgres.JSONValue)},
            child_snapshot = ${tx.json(doc.child as unknown as postgres.JSONValue)},
            prescriber_snapshot = ${tx.json(doc.prescriber as unknown as postgres.JSONValue)},
            content_md = ${contentMd}, content_hash = ${hash}, pdf_path = ${pdfPath},
            signed_by = ${input.actorUserId}, signed_at = ${doc.signed_at}
        where id = ${draft.id}
        returning *`;
      await tx`
        update prescriptions set status = 'signed', prescriber_profile_id = ${profile.id}, version = version + 1, updated_at = now()
        where id = ${rx.id}`;
      const published = await publishVersion(tx, {
        entityType: "prescription",
        entityId: rx.id,
        caseId: rx.case_id,
        contentMd,
        visibleToGuardian: true,
        publishedBy: input.actorUserId,
      });
      await auditStrict(
        {
          caseId: rx.case_id,
          actorUserId: input.actorUserId,
          action: "rx.signed",
          entity: "prescription",
          entityId: rx.id,
          details: {
            version: draft.version,
            items: draft.items.length,
            content_hash: hash,
            prescriber_profile_id: profile.id,
            allergy_status: doc.allergies.status,
            allergy_override: matches.length > 0,
            health_profile_version: facts.version,
            published_version: published.version,
          },
        },
        tx,
      );
      const eventId = await enqueue(tx, {
        topic: "prescription.signed",
        aggregateType: "prescription",
        aggregateId: rx.id,
        payload: { prescription_id: rx.id, child_id: rx.child_id, case_id: rx.case_id },
        dedupKey: `prescription:${rx.id}:signed`,
      });
      // Last step before commit: the PDF object (deterministic path; removed again if the commit fails).
      await uploadPdf(pdfPath, await renderPrescriptionPdf(doc, hash));
      uploaded = pdfPath;
      return { ok: true as const, version: toVersion(signed), published_version: published.version, matches, event_ids: [eventId] };
    });
  } catch (err) {
    if (uploaded) {
      const { error } = await supabaseAdmin().storage.from(PRESCRIPTIONS_BUCKET).remove([uploaded]);
      if (error) log.error(`could not remove an uncommitted prescription PDF: ${errorMessage(error)}`);
    }
    throw err;
  }
}

/** FR-1/FR-5: `Void` a signed prescription with a reason (no new version; guardians see `Cancelled by prescriber`). */
export async function voidPrescription(input: {
  prescriptionId: string;
  actorUserId: string;
  reason: string;
}): Promise<{ ok: true; prescription: PrescriptionRow; event_ids: string[] } | Failure> {
  const sql = await db();
  return sql.begin(async (tx) => {
    const rx = await loadPrescription(tx, input.prescriptionId, true);
    if (!rx) return fail(404, MSG.notFound);
    if (rx.status === "void") return fail(409, "This prescription is already cancelled");
    if (rx.status !== "signed") return fail(409, MSG.notSigned);
    const signed = await loadVersion(tx, rx.id, rx.current_version);
    if (!signed?.signed_at) return fail(409, MSG.notSigned);
    const [row] = await tx<Record<string, unknown>[]>`
      update prescriptions
      set status = 'void', void_reason = ${input.reason}, voided_by = ${input.actorUserId}, voided_at = now(),
          version = version + 1, updated_at = now()
      where id = ${rx.id}
      returning *`;
    const voided = toPrescription(row);
    const published = await publishVersion(tx, {
      entityType: "prescription",
      entityId: rx.id,
      caseId: rx.case_id,
      contentMd: cancelledMarkdown(signed.signed_at, voided.voided_at as string, signed.prescriber_snapshot?.name ?? ""),
      visibleToGuardian: true,
      publishedBy: input.actorUserId,
    });
    await auditStrict(
      {
        caseId: rx.case_id,
        actorUserId: input.actorUserId,
        action: "rx.voided",
        entity: "prescription",
        entityId: rx.id,
        details: { version: signed.version, published_version: published.version },
      },
      tx,
    );
    const eventId = await enqueue(tx, {
      topic: "prescription.voided",
      aggregateType: "prescription",
      aggregateId: rx.id,
      payload: { prescription_id: rx.id, child_id: rx.child_id, case_id: rx.case_id },
      dedupKey: `prescription:${rx.id}:void`,
    });
    return { ok: true as const, prescription: voided, event_ids: [eventId] };
  });
}

// ---------------------------------------------------------------------------------------------------------
// PDF

/** The signed version currently in effect (signed or void prescriptions), or null. */
export async function signedVersionOf(prescriptionId: string): Promise<{ prescription: PrescriptionRow; version: VersionRow } | null> {
  const sql = await db();
  const prescription = await loadPrescription(sql, prescriptionId);
  if (!prescription || prescription.status === "draft") return null;
  const version = await loadVersion(sql, prescription.id, prescription.current_version);
  if (!version?.signed_at) return null;
  return { prescription, version };
}

/**
 * The stored PDF of a signed version. A missing object (e.g. storage restored from an older backup) is regenerated
 * from the version's snapshots, but only when the regenerated `content_md` has the stored `content_hash` (NFR-2).
 */
export async function prescriptionPdfBytes(version: VersionRow): Promise<Uint8Array> {
  if (version.pdf_path) {
    const { data } = await supabaseAdmin().storage.from(PRESCRIPTIONS_BUCKET).download(version.pdf_path);
    if (data) return new Uint8Array(await data.arrayBuffer());
  }
  const doc = documentOf(version);
  const hash = contentHash(prescriptionMarkdown(doc));
  if (hash !== version.content_hash) throw new Error("regenerated prescription does not match its content hash");
  const bytes = await renderPrescriptionPdf(doc, hash);
  if (version.pdf_path) await uploadPdf(version.pdf_path, bytes).catch((err) => log.error(errorMessage(err)));
  return bytes;
}

export function pdfFileName(version: Pick<VersionRow, "signed_at" | "version">): string {
  const date = (version.signed_at ?? "").slice(0, 10) || "draft";
  return `prescription-${date}-v${version.version}.pdf`;
}

// ---------------------------------------------------------------------------------------------------------
// Guardians (FR-5): signed prescriptions whose latest published version is visible to the guardian.

export type GuardianPrescription = {
  id: string;
  status: "signed" | "void";
  org_name: string;
  prescriber_name: string;
  signed_at: string;
  voided_at: string | null;
  content_md: string;
  published_at: string;
};

/** Caller must have checked the guardian's active link to the child (requireChildGuardian[Page]). */
export async function listGuardianPrescriptions(childId: string): Promise<GuardianPrescription[]> {
  if (!isUuid(childId)) return [];
  const sql = await db();
  const rows = await sql<
    {
      id: string;
      status: "signed" | "void";
      org_name: string;
      prescriber_name: string;
      signed_at: Date;
      voided_at: Date | null;
      content_md: string;
      published_at: Date;
    }[]
  >`
    select p.id, p.status, coalesce(o.public_name, o.name) as org_name, v.prescriber_snapshot ->> 'name' as prescriber_name,
           v.signed_at, p.voided_at, pv.content_md, pv.published_at
    from prescriptions p
    join prescription_versions v on v.prescription_id = p.id and v.version = p.current_version and v.signed_at is not null
    join organizations o on o.id = p.org_id
    join lateral (
      select content_md, published_at, visible_to_guardian from published_versions
      where entity_type = 'prescription' and entity_id = p.id
      order by version desc limit 1
    ) pv on pv.visible_to_guardian
    where p.child_id = ${childId} and p.status in ('signed', 'void')
    order by v.signed_at desc`;
  return rows.map((r) => ({
    ...r,
    signed_at: iso(r.signed_at) as string,
    voided_at: iso(r.voided_at),
    published_at: iso(r.published_at) as string,
  }));
}

/** For the guardian PDF route: the child of a signed (not void) prescription that is published to guardians. */
export async function guardianDownloadable(prescriptionId: string): Promise<{ childId: string } | null> {
  if (!isUuid(prescriptionId)) return null;
  const sql = await db();
  const [row] = await sql<{ child_id: string }[]>`
    select p.child_id from prescriptions p
    join lateral (
      select visible_to_guardian from published_versions
      where entity_type = 'prescription' and entity_id = p.id order by version desc limit 1
    ) pv on pv.visible_to_guardian
    where p.id = ${prescriptionId} and p.status = 'signed'`;
  return row ? { childId: row.child_id } : null;
}
