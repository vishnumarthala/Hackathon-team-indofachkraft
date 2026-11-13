// 041 FR-5: the privacy registry. Every category of personal data the app stores is listed here once, with its owner,
// storage, retention rule, the processors that receive it, and how it is exported (FR-7) and erased (FR-8).
// lib/privacy/export.ts, lib/privacy/deletion.ts, the privacy notice (/privacy) and docs/privacy/retention.md are all
// driven by this list. The scheduled retention steps are in lib/privacy/retention.ts (keyed by the same `key`).
//
// Extending (026 home program, M2/M3 tickets; 024, 025 and 027 are registered below): append an entry to
// `REGISTRY` (or call `registerPrivacyCategory()` from your module) with
//   * `export(ctx)`  - ONLY what the requesting guardian can already see in the portal (published versions, their
//                      own messages, ...), as JSON-safe data; optional `files` for the ZIP;
//   * `erase`        - `objects()` (storage paths, removed before any row is deleted), `externalRefs()` (processor
//                      copies, e.g. ElevenLabs conversation ids) and `rows(tx)` (runs inside the erasure transaction,
//                      before the child's cases are deleted - delete rows that do not cascade from `cases`/`children`);
//                      say which `scopes` the category belongs to (`all_ai_processing` = AI-derived or AI-processed);
//   * `retention`    - the rule as shown in the privacy notice; add a step in retention.ts if it needs a job.
// Rows referencing `cases(id)` / `children(id)` with `on delete cascade` are removed by the final erasure step anyway;
// still register the category so it appears in the notice, the export and the docs. See docs/privacy/retention.md.
import type { Queryable, Tx } from "@/lib/pg";

export type DataOwner = "child" | "case" | "user";
export type Processor = "elevenlabs" | "gemini" | "resend" | "whatsapp" | "supabase" | "razorpay" | "google";
export type DeletionScope = "all_ai_processing" | "everything";

export type ExportContext = { sql: Queryable; childId: string; guardianUserId: string };
export type ExportFile = { path: string; bucket: string; objectPath: string };
export type ExportSection = { data: unknown; files?: ExportFile[] };

export type ErasureContext = {
  childId: string;
  requestId: string;
  scope: DeletionScope;
  requestedBy: string;
  /** All cases of the child, in every organisation (rule 2: the guardian's erasure right is platform-wide). */
  caseIds: string[];
};
export type StorageRef = { bucket: string; path: string };
export type ExternalRef = { processor: Processor; ref: string };

export type PrivacyCategory = {
  key: string;
  label: string;
  owner: DataOwner;
  tables: string[];
  buckets?: string[];
  /** Plain-language rule shown in the privacy notice and docs (English; the notice translates by key). */
  retention: string;
  /** Env var that overrides the period, if any (lib/privacy/retention.ts). */
  retentionEnv?: string;
  processors: Processor[];
  /** Kept on erasure because of a legal obligation (free text is stripped instead). */
  retainedOnErasure?: boolean;
  export?: (ctx: ExportContext) => Promise<ExportSection | null>;
  erase?: {
    scopes: DeletionScope[];
    objects?: (sql: Queryable, ctx: ErasureContext) => Promise<StorageRef[]>;
    externalRefs?: (sql: Queryable, ctx: ErasureContext) => Promise<ExternalRef[]>;
    rows?: (tx: Tx, ctx: ErasureContext) => Promise<number>;
  };
};

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v);

function rowsJson<T extends Record<string, unknown>>(rows: readonly T[]): T[] {
  return rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, iso(v)])) as T);
}

const AI_SCOPES: DeletionScope[] = ["all_ai_processing", "everything"];
const EVERYTHING: DeletionScope[] = ["everything"];

export const REGISTRY: PrivacyCategory[] = [
  {
    key: "child_profile",
    label: "Child profile and guardian links",
    owner: "child",
    tables: ["children", "guardian_links", "child_claim_codes"],
    retention: "While the account is active; on erasure the name becomes 'Deleted child' and links are revoked.",
    processors: ["supabase"],
    export: async ({ sql, childId, guardianUserId }) => {
      const [child] = await sql`
        select id, display_name, date_of_birth::text as date_of_birth, sex, created_at from public.children where id = ${childId}`;
      const links = await sql`
        select relationship, status, verification_method, created_at, revoked_at, (user_id = ${guardianUserId}) as is_you
        from public.guardian_links where child_id = ${childId} order by created_at`;
      return { data: { child: child ? rowsJson([child])[0] : null, guardian_links: rowsJson(links) } };
    },
    // Pseudonymisation and link revocation happen in the final erasure step (lib/privacy/deletion.ts).
    erase: { scopes: EVERYTHING },
  },
  {
    key: "case_records",
    label: "Clinical case records (sessions, transcripts, AI-extracted facts, reports, referrals, questions)",
    owner: "case",
    tables: ["cases", "recordings", "facts", "reports", "referrals", "case_questions"],
    retention:
      "Kept while the child is in care at the organisation (clinical records). Erasure requests are reviewed by DoctorNearMe; a legal record-keeping duty can be a reason to refuse.",
    processors: ["supabase", "elevenlabs", "gemini", "resend"],
    erase: {
      scopes: AI_SCOPES,
      rows: async (tx, ctx) => {
        if (ctx.caseIds.length === 0) return 0;
        if (ctx.scope === "everything") return 0; // cases are deleted (with every cascading row) in the final step
        // all_ai_processing: transcripts and AI output go; clinician-confirmed facts and final reports stay.
        const a = await tx`
          update public.recordings set segments = '[]'::jsonb, red_flags = '[]'::jsonb, speaker_map = '{}'::jsonb
          where case_id in ${tx(ctx.caseIds)} and (segments <> '[]'::jsonb or red_flags <> '[]'::jsonb)`;
        const b = await tx`delete from public.facts where case_id in ${tx(ctx.caseIds)} and status = 'suggested'`;
        const c = await tx`delete from public.reports where case_id in ${tx(ctx.caseIds)} and status = 'draft'`;
        const d = await tx`
          delete from public.case_questions where referral_id in (select id from public.referrals where case_id in ${tx(ctx.caseIds)})`;
        return a.count + b.count + c.count + d.count;
      },
    },
  },
  {
    key: "session_audio",
    label: "Session and intake audio, parent voice notes",
    owner: "case",
    tables: ["recordings.storage_path", "reports.audio_path"],
    buckets: ["recordings"],
    retention: "Raw audio is deleted 90 days after successful transcription (the transcript and facts are kept).",
    retentionEnv: "RETENTION_AUDIO_DAYS",
    processors: ["supabase", "elevenlabs"],
    erase: {
      scopes: AI_SCOPES,
      objects: async (sql, ctx) => {
        if (ctx.caseIds.length === 0) return [];
        const rows = await sql<{ path: string }[]>`
          select storage_path as path from public.recordings where case_id in ${sql(ctx.caseIds)} and storage_path is not null
          union
          select audio_path from public.reports where case_id in ${sql(ctx.caseIds)} and audio_path is not null`;
        return rows.map((r) => ({ bucket: "recordings", path: r.path }));
      },
      rows: async (tx, ctx) => {
        if (ctx.caseIds.length === 0) return 0;
        const a = await tx`
          update public.recordings set storage_path = null, audio_deleted_at = coalesce(audio_deleted_at, now())
          where case_id in ${tx(ctx.caseIds)} and storage_path is not null`;
        const b = await tx`update public.reports set audio_path = null where case_id in ${tx(ctx.caseIds)} and audio_path is not null`;
        return a.count + b.count;
      },
    },
  },
  {
    key: "intake_conversations",
    label: "AI intake call conversations held by ElevenLabs",
    owner: "case",
    tables: ["recordings.external_id"],
    retention: "Deleted at ElevenLabs when a deletion request is carried out (processor deletion log).",
    processors: ["elevenlabs"],
    erase: {
      scopes: AI_SCOPES,
      externalRefs: async (sql, ctx) => {
        if (ctx.caseIds.length === 0) return [];
        const rows = await sql<{ external_id: string }[]>`
          select external_id from public.recordings where case_id in ${sql(ctx.caseIds)} and external_id is not null`;
        return rows.map((r) => ({ processor: "elevenlabs", ref: r.external_id }));
      },
    },
  },
  {
    key: "assessments",
    label: "Questionnaires assigned to the guardian and their answers (024)",
    owner: "case",
    tables: ["assessments", "assessment_responses"],
    retention: "Kept with the clinical record of the case; deleted with the child's cases on erasure.",
    processors: ["supabase"],
    // Exactly the guardian's portal view (024 listGuardianAssessments): questionnaires assigned to this guardian, not
    // cancelled, with their own answers. Provider scores and reviewer notes are not shown in the portal: not exported.
    export: async ({ sql, childId, guardianUserId }) => {
      const rows = await sql<{ id: string; title: string; instrument_key: string; status: string; due_on: string | null; submitted_at: Date | null; created_at: Date }[]>`
        select a.id, t.title, t.instrument_key, a.status, a.due_on::text as due_on, a.submitted_at, a.created_at
        from public.assessments a join public.assessment_templates t on t.id = a.template_id
        where a.child_id = ${childId} and a.assigned_to = ${guardianUserId} and a.status <> 'cancelled'
        order by a.created_at`;
      const answers = rows.length
        ? await sql<{ assessment_id: string; item_id: string; value: unknown; answered_at: Date }[]>`
            select assessment_id, item_id, value, answered_at from public.assessment_responses
            where assessment_id in ${sql(rows.map((r) => r.id))} order by assessment_id, item_id`
        : [];
      return {
        data: rowsJson(rows).map((r) => ({
          ...r,
          answers: rowsJson(answers.filter((x) => x.assessment_id === r.id)).map(({ item_id, value, answered_at }) => ({ item_id, value, answered_at })),
        })),
      };
    },
    // Rows cascade from `cases` (final erasure step); deleted explicitly too so nothing depends on cascade order.
    erase: {
      scopes: EVERYTHING,
      rows: async (tx, ctx) => (await tx`delete from public.assessments where child_id = ${ctx.childId}`).count,
    },
  },
  {
    key: "published_versions",
    label: "Published clinical documents (reports, plans, questionnaire summaries) (024)",
    owner: "case",
    tables: ["published_versions"],
    retention: "Append-only clinical record, kept while the child is in care; removed with the case on erasure.",
    processors: ["supabase"],
    // 024 listGuardianVisible: the latest version of each document, only when it is visible to the guardian.
    export: async ({ sql, childId }) => {
      const rows = await sql`
        select entity_type, entity_id, version, content_md, published_at from (
          select distinct on (entity_type, entity_id) * from public.published_versions
          where child_id = ${childId} order by entity_type, entity_id, version desc
        ) latest
        where visible_to_guardian order by published_at`;
      return { data: rowsJson(rows) };
    },
    // Case-linked rows go with the cases (024's trigger allows only that); case-less rows need the 041 exception.
    erase: {
      scopes: EVERYTHING,
      rows: async (tx, ctx) =>
        (await tx<{ n: number }[]>`select public.privacy_delete_published_versions(${ctx.childId}::uuid) as n`)[0].n,
    },
  },
  {
    key: "iep_plans",
    label: "IEP plans, SMART goals, progress and published plan snapshots (025)",
    owner: "case",
    tables: ["iep_plans", "iep_goals", "goal_progress", "iep_publications"],
    retention: "Kept with the clinical record of the case; deleted with the child's cases on erasure.",
    processors: ["supabase"],
    // 025 getGuardianPlans: the latest published plan per organisation with published goal wording and live values.
    // Drafts and progress notes are never exported.
    export: async ({ childId }) => {
      const { getGuardianPlans } = await import("@/lib/iep");
      return { data: await getGuardianPlans(childId) };
    },
    erase: {
      scopes: EVERYTHING,
      rows: async (tx, ctx) => (await tx`delete from public.iep_plans where child_id = ${ctx.childId}`).count,
    },
  },
  {
    // 033: public developmental check-ins. Anonymous rows (no child link, no IP, no free text) are deleted after 30
    // days by the retention job; a check-in the guardian saved to a child (020 consent `screen_result_save`) stays
    // with the child until erasure. Voice check-ins have an ElevenLabs conversation id (processor copy).
    key: "screen_results",
    label: "Developmental check-ins from the public check-in page (033)",
    owner: "child",
    tables: ["screen_sessions"],
    retention: "Check-ins that were not saved to a child are deleted after 30 days; saved check-ins stay with the child until erasure.",
    processors: ["supabase", "elevenlabs"],
    // Exactly the portal's `Check-ins` list (date, age band, result band).
    export: async ({ sql, childId }) => {
      const rows = await sql`
        select id, created_at, age_band, mode, result_band from public.screen_sessions
        where saved_child_id = ${childId} order by created_at`;
      return { data: rowsJson(rows) };
    },
    erase: {
      scopes: AI_SCOPES,
      externalRefs: async (sql, ctx) => {
        const rows = await sql<{ conversation_id: string }[]>`
          select conversation_id from public.screen_sessions where saved_child_id = ${ctx.childId} and conversation_id is not null`;
        return rows.map((r) => ({ processor: "elevenlabs", ref: r.conversation_id }));
      },
      rows: async (tx, ctx) => {
        if (ctx.scope === "everything") return (await tx`delete from public.screen_sessions where saved_child_id = ${ctx.childId}`).count;
        // all_ai_processing: the voice conversation goes (above); the tap/voice answers and the band stay.
        return (
          await tx`update public.screen_sessions set conversation_id = null where saved_child_id = ${ctx.childId} and conversation_id is not null`
        ).count;
      },
    },
  },
  {
    key: "ai_scribe",
    label: "AI scribe drafts: session notes, goal-progress suggestions and prescription drafts (038)",
    owner: "case",
    tables: ["reports.session_note", "reports.rx_draft", "goal_progress_suggestions"],
    retention:
      "Drafts and suggestions are kept with the clinical record of the case until the clinician decides; finalized notes are clinical records (published versions). Deleted with the child's cases on erasure.",
    processors: ["supabase", "gemini"],
    // No export section of its own: the guardian sees only finalized notes the clinician shared, which the
    // `published_versions` export already contains. Drafts and suggestions are never shown to guardians (NFR-1).
    erase: {
      scopes: AI_SCOPES,
      rows: async (tx, ctx) => {
        if (ctx.caseIds.length === 0 || ctx.scope === "everything") return 0; // cascades with the cases
        // all_ai_processing: undecided/rejected AI suggestions go; accepted ones keep the decision but lose the
        // transcript quotes and AI rationale (draft reports are removed by `case_records`).
        const a = await tx`
          delete from public.goal_progress_suggestions
          where case_id in ${tx(ctx.caseIds)} and status in ('suggested', 'rejected')`;
        const b = await tx`
          update public.goal_progress_suggestions set evidence = '[]'::jsonb, rationale = ''
          where case_id in ${tx(ctx.caseIds)} and status = 'accepted' and (evidence <> '[]'::jsonb or rationale <> '')`;
        return a.count + b.count;
      },
    },
  },
  {
    key: "home_programs",
    label: "Home programs, activities, guardian practice logs and published program snapshots (026)",
    owner: "case",
    tables: ["home_programs", "home_activities", "home_activity_logs", "home_program_publications"],
    retention: "Kept with the clinical record of the case; practice logs are deleted with the child's cases on erasure.",
    processors: ["supabase"],
    // 026 getGuardianHomePrograms: the current published programs (snapshot wording, this week's counts) plus the
    // requesting guardian's OWN practice logs, with activity titles from the published snapshots. Drafts, unpublished
    // edits and other guardians' notes are never exported.
    export: async ({ sql, childId, guardianUserId }) => {
      const { getGuardianHomePrograms } = await import("@/lib/home-program");
      const logs = await sql`
        select l.activity_id,
               (select a ->> 'title' from public.home_program_publications hpp, jsonb_array_elements(hpp.activities) a
                where a ->> 'id' = l.activity_id::text order by hpp.created_at desc limit 1) as activity_title,
               l.done_on::text as done_on, l.difficulty, l.duration_min, l.note, l.created_at, l.updated_at
        from public.home_activity_logs l
        where l.child_id = ${childId} and l.logged_by = ${guardianUserId}
        order by l.done_on, l.created_at`;
      return { data: { programs: await getGuardianHomePrograms(childId), your_logs: rowsJson(logs) } };
    },
    // Logs reference children without cascade: delete them before the programs (which cascade from `cases` anyway).
    erase: {
      scopes: EVERYTHING,
      rows: async (tx, ctx) => {
        const logs = await tx`delete from public.home_activity_logs where child_id = ${ctx.childId}`;
        const programs = await tx`delete from public.home_programs where child_id = ${ctx.childId}`;
        return logs.count + programs.count;
      },
    },
  },
  {
    key: "prescriptions",
    label: "Prescriptions: drafts, signed versions with child/allergy/prescriber snapshots, and their PDFs (039)",
    owner: "case",
    tables: ["prescriptions", "prescription_versions"],
    buckets: ["prescriptions"],
    retention:
      "Signed prescriptions are clinical records kept while the child is in care at the organisation (signed versions cannot be changed or deleted); deleted with the child's cases on erasure.",
    processors: ["supabase"],
    // Exactly the guardian's portal view (FR-5): signed prescriptions whose latest published version is visible to
    // the guardian, with that text and (unless cancelled) the PDF. Drafts and void reasons are never exported.
    export: async ({ sql, childId }) => {
      const rows = await sql<{ id: string; status: string; version: number; signed_at: Date; voided_at: Date | null; content_md: string; pdf_path: string | null }[]>`
        select p.id, p.status, v.version, v.signed_at, p.voided_at, pv.content_md, v.pdf_path
        from public.prescriptions p
        join public.prescription_versions v on v.prescription_id = p.id and v.version = p.current_version and v.signed_at is not null
        join lateral (
          select content_md, visible_to_guardian from public.published_versions
          where entity_type = 'prescription' and entity_id = p.id order by version desc limit 1
        ) pv on pv.visible_to_guardian
        where p.child_id = ${childId} and p.status in ('signed', 'void')
        order by v.signed_at`;
      const file = (r: (typeof rows)[number]) => `prescriptions/${r.id}-v${r.version}.pdf`;
      return {
        data: rows.map((r) => ({
          id: r.id,
          status: r.status === "void" ? "cancelled" : "signed",
          signed_at: iso(r.signed_at),
          cancelled_at: iso(r.voided_at),
          content_md: r.content_md,
          file: r.status === "signed" && r.pdf_path ? file(r) : null,
        })),
        files: rows
          .filter((r) => r.status === "signed" && r.pdf_path)
          .map((r) => ({ path: file(r), bucket: "prescriptions", objectPath: r.pdf_path as string })),
      };
    },
    // Rows go with the child's cases in the final erasure step (signed rows only through the case cascade, triggers in
    // 20261113003900_prescriptions.sql); the PDFs are removed first.
    erase: {
      scopes: EVERYTHING,
      objects: async (sql, ctx) => {
        const rows = await sql<{ path: string }[]>`
          select v.pdf_path as path from public.prescription_versions v
          join public.prescriptions p on p.id = v.prescription_id
          where p.child_id = ${ctx.childId} and v.pdf_path is not null`;
        return rows.map((r) => ({ bucket: "prescriptions", path: r.path }));
      },
    },
  },
  {
    key: "documents",
    label: "Document vault (uploads by the family and the care team)",
    owner: "child",
    tables: ["documents", "document_org_shares"],
    buckets: ["documents"],
    retention: "Until deleted by the uploader or erased; unfinished uploads are removed after 1 hour.",
    processors: ["supabase"],
    export: async ({ sql, childId }) => {
      // Exactly the guardian's portal view (023 FR-7): ready, and a family upload or visible to the guardian.
      const docs = await sql<{ id: string; title: string; category: string; file_name: string; mime_type: string; size_bytes: string; uploader_kind: string; storage_path: string; created_at: Date }[]>`
        select id, title, category, file_name, mime_type, size_bytes, uploader_kind, storage_path, created_at
        from public.documents
        where child_id = ${childId} and status = 'ready' and (uploader_kind = 'guardian' or visible_to_guardian)
        order by created_at`;
      const safe = (name: string) => name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120);
      return {
        data: docs.map((d) => ({
          id: d.id,
          title: d.title,
          category: d.category,
          file_name: d.file_name,
          mime_type: d.mime_type,
          size_bytes: Number(d.size_bytes),
          uploaded_by: d.uploader_kind,
          created_at: iso(d.created_at),
          file: `documents/${d.id}-${safe(d.file_name)}`,
        })),
        files: docs.map((d) => ({ path: `documents/${d.id}-${safe(d.file_name)}`, bucket: "documents", objectPath: d.storage_path })),
      };
    },
    erase: {
      scopes: EVERYTHING,
      objects: async (sql, ctx) => {
        const rows = await sql<{ path: string }[]>`select storage_path as path from public.documents where child_id = ${ctx.childId}`;
        return rows.map((r) => ({ bucket: "documents", path: r.path }));
      },
      rows: async (tx, ctx) => (await tx`delete from public.documents where child_id = ${ctx.childId}`).count,
    },
  },
  {
    key: "health_profile",
    label: "Health profile and its history",
    owner: "child",
    tables: ["child_health_profiles", "child_health_profile_history"],
    retention: "While the account is active; deleted on erasure.",
    processors: ["supabase"],
    export: async ({ sql, childId }) => {
      const [current] = await sql`
        select blood_group, allergies, medications, conditions, birth_history, developmental_history,
               emergency_contact_name, emergency_contact_phone, version, updated_at
        from public.child_health_profiles where child_id = ${childId}`;
      const history = await sql`
        select version, snapshot, changed_fields, changed_at from public.child_health_profile_history
        where child_id = ${childId} order by version`;
      return { data: { current: current ? rowsJson([current])[0] : null, history: rowsJson(history) } };
    },
    erase: {
      scopes: EVERYTHING,
      rows: async (tx, ctx) => {
        const a = await tx`delete from public.child_health_profile_history where child_id = ${ctx.childId}`;
        const b = await tx`delete from public.child_health_profiles where child_id = ${ctx.childId}`;
        return a.count + b.count;
      },
    },
  },
  {
    key: "consent_records",
    label: "Consent log and signed paper consent forms",
    owner: "child",
    tables: ["consent_records"],
    buckets: ["consent-forms"],
    retention:
      "Kept as evidence of consent (legal obligation), also after erasure, with free text removed. Unattached scans are removed after 24 hours.",
    processors: ["supabase"],
    retainedOnErasure: true,
    export: async ({ sql, childId, guardianUserId }) => {
      const rows = await sql`
        select r.feature, r.action, r.method, d.version as document_version, d.locale as document_locale,
               r.paper_signed_on::text as paper_signed_on, r.created_at, (r.guardian_user_id = ${guardianUserId}) as by_you
        from public.consent_records r left join public.consent_documents d on d.id = r.consent_document_id
        where r.child_id = ${childId} order by r.seq`;
      return { data: rowsJson(rows) };
    },
  },
  {
    key: "sharing_and_care_team",
    label: "Sharing grants between organisations and the care team",
    owner: "child",
    tables: ["sharing_grants", "case_assignments"],
    retention: "While in force; grants are revoked on erasure.",
    processors: ["supabase"],
    export: async ({ sql, childId }) => {
      const grants = await sql`
        select g.id, coalesce(so.public_name, so.name) as from_org, coalesce(go.public_name, go.name) as to_org, g.scopes,
               g.created_at, g.expires_at, g.revoked_at
        from public.sharing_grants g
        join public.organizations so on so.id = g.source_org_id
        join public.organizations go on go.id = g.grantee_org_id
        where g.child_id = ${childId} order by g.created_at`;
      const team = await sql`select org_name, display_name, provider_type, discipline_label, care_role from public.list_child_care_team(${childId})`;
      return { data: { sharing_grants: rowsJson(grants), care_team: rowsJson(team) } };
    },
    erase: {
      scopes: EVERYTHING,
      rows: async (tx, ctx) =>
        (await tx`update public.sharing_grants set revoked_at = now() where child_id = ${ctx.childId} and revoked_at is null`).count,
    },
  },
  {
    // 027: case-scoped conversations between the child's guardians and one organisation's care team.
    key: "messages",
    label: "Messages with the care team (027)",
    owner: "case",
    tables: ["message_threads", "messages", "thread_reads"],
    retention:
      "Kept with the clinical record of the case; a deleted message's text is overwritten at once; deleted with the child's cases on erasure.",
    processors: ["supabase"],
    // Only conversations this guardian can open in the portal (thread_access_level = 'guardian'), with the text they
    // see (deleted messages as `This message was deleted.`), and only their own read markers. Attached documents
    // are exported by the `documents` category; here only their ids.
    export: async ({ sql, childId, guardianUserId }) => {
      const threads = await sql<{ id: string; subject: string; org_name: string; created_at: Date; archived_at: Date | null; last_read_at: Date | null }[]>`
        select t.id, t.subject, o.name as org_name, t.created_at, t.archived_at, r.last_read_at
        from public.message_threads t
        join public.organizations o on o.id = t.org_id
        left join public.thread_reads r on r.thread_id = t.id and r.user_id = ${guardianUserId}
        where t.child_id = ${childId} and public.thread_access_level(${guardianUserId}, t.id) = 'guardian'
        order by t.created_at`;
      if (threads.length === 0) return { data: [] };
      const messages = await sql<{ thread_id: string; id: string; sender_kind: string; own: boolean; body: string; document_id: string | null; created_at: Date; deleted_at: Date | null }[]>`
        select m.thread_id, m.id, m.sender_kind, m.sender_id = ${guardianUserId} as own,
               m.body, m.document_id, m.created_at, m.deleted_at
        from public.messages m
        where m.thread_id in ${sql(threads.map((t) => t.id))}
        order by m.created_at, m.id`;
      return {
        data: rowsJson(threads).map((t) => ({
          ...t,
          messages: rowsJson(messages.filter((m) => m.thread_id === t.id).map((m) => ({ id: m.id, sender_kind: m.sender_kind, own: m.own, body: m.body, document_id: m.document_id, created_at: m.created_at, deleted_at: m.deleted_at }))),
        })),
      };
    },
    erase: {
      scopes: EVERYTHING,
      // Threads cascade from cases as well; deleting them here also covers every organisation's threads of the
      // child, and their outbox events (ids only) go with them.
      rows: async (tx, ctx) => {
        await tx`
          delete from public.outbox_events
          where aggregate_type = 'thread'
            and aggregate_id in (select id from public.message_threads where child_id = ${ctx.childId})`;
        return (await tx`delete from public.message_threads where child_id = ${ctx.childId}`).count;
      },
    },
  },
  {
    key: "notifications",
    label: "Notifications (in-app, email and WhatsApp delivery log)",
    owner: "user",
    tables: ["outbox_events", "notifications", "notification_preferences"],
    retention:
      "In-app notifications are deleted after 180 days; email/WhatsApp delivery rows lose their title and text after 90 days.",
    processors: ["supabase", "resend", "whatsapp"],
    erase: {
      scopes: EVERYTHING,
      rows: async (tx, ctx) =>
        (await tx`delete from public.outbox_events where payload ->> 'child_id' = ${ctx.childId}`).count,
    },
  },
  {
    key: "privacy_exports",
    label: "Data exports requested by guardians",
    owner: "child",
    tables: ["privacy_exports"],
    buckets: ["exports"],
    retention: "Export files are deleted 7 days after they are ready.",
    retentionEnv: "RETENTION_EXPORT_DAYS",
    processors: ["supabase"],
    erase: {
      scopes: EVERYTHING,
      objects: async (sql, ctx) => {
        const rows = await sql<{ path: string }[]>`
          select storage_path as path from public.privacy_exports where child_id = ${ctx.childId} and storage_path is not null`;
        return rows.map((r) => ({ bucket: "exports", path: r.path }));
      },
      rows: async (tx, ctx) => (await tx`delete from public.privacy_exports where child_id = ${ctx.childId}`).count,
    },
  },
  {
    // 030 NFR-4. Retention period pending legal review (rd.md open question): kept as the provider's schedule record.
    key: "appointments",
    label: "Appointments (booked time, provider, service, status history)",
    owner: "child",
    tables: ["appointments", "appointment_events"],
    retention:
      "Kept as the provider's appointment record (period pending legal review). On erasure, future appointments are cancelled and the child is removed from every appointment.",
    processors: ["supabase", "resend", "whatsapp"],
    export: async ({ sql, childId, guardianUserId }) => {
      // Only the requesting guardian's own bookings (what /family/appointments shows them).
      const rows = await sql`
        select a.id, lower(a.slot) as starts_at, upper(a.slot) as ends_at, a.status, a.service_snapshot ->> 'name' as service,
               a.service_snapshot ->> 'mode' as mode, a.service_snapshot -> 'location' ->> 'name' as location,
               p.display_name as provider, a.cancelled_by, a.rescheduled_from, a.created_at
        from public.appointments a join public.provider_profiles p on p.id = a.provider_profile_id
        where a.child_id = ${childId} and a.guardian_user_id = ${guardianUserId} and a.status not in ('held', 'expired')
        order by lower(a.slot)`;
      return { data: rowsJson(rows) };
    },
    erase: {
      scopes: EVERYTHING,
      rows: async (tx, ctx) => {
        const [row] = await tx<{ n: number }[]>`select public.booking_erase_child(${ctx.childId}) as n`;
        return row.n;
      },
    },
  },
  {
    // 035: appointment-bound pre-consult intake links. Calls and briefs are `case_records` / `intake_conversations`.
    key: "intake_attempts",
    label: "Pre-consult intake links of appointments (link hash, status, call reference)",
    owner: "case",
    tables: ["intake_attempts"],
    retention:
      "Kept with the case and deleted with it. Only a hash of the link is stored; the link stops working when the appointment starts or is cancelled.",
    processors: ["supabase"],
    erase: {
      scopes: EVERYTHING,
      rows: async (tx, ctx) => {
        if (ctx.caseIds.length === 0) return 0;
        return (await tx`delete from public.intake_attempts where case_id in ${tx(ctx.caseIds)}`).count;
      },
    },
  },
  {
    // 031 NFR-3: online prepayments. Amounts, statuses and Razorpay ids only; never card, UPI, bank or wallet details
    // (webhook payloads are allowlisted before storage, lib/payments/webhook.ts).
    key: "payments",
    label: "Payments for appointments (amount, status, refunds)",
    owner: "user",
    tables: ["payments", "payment_events"],
    retention:
      "Kept as a financial record (period pending legal review; Indian accounting rules usually require 8 years), also after erasure. Holds no child data and no card or UPI details.",
    processors: ["supabase", "razorpay"],
    retainedOnErasure: true,
    export: async ({ sql, childId, guardianUserId }) => {
      // Only the requesting guardian's own payments for this child's appointments.
      const rows = await sql`
        select p.appointment_id, p.amount_paise, p.currency, p.status, p.refund_reason, p.created_at, p.captured_at, p.refunded_at,
               p.razorpay_order_id, p.razorpay_payment_id
        from public.payments p join public.appointments a on a.id = p.appointment_id
        where a.child_id = ${childId} and a.guardian_user_id = ${guardianUserId}
        order by p.created_at`;
      return { data: rowsJson(rows) };
    },
  },
  {
    key: "audit_events",
    label: "Audit log",
    owner: "case",
    tables: ["audit_events"],
    retention: "Kept for 7 years (legal obligation), also after erasure, with free text removed.",
    retentionEnv: "RETENTION_AUDIT_YEARS",
    processors: ["supabase"],
    retainedOnErasure: true,
  },
  {
    key: "provider_credentials",
    label: "Provider registration certificates",
    owner: "user",
    tables: ["credential_submissions"],
    buckets: ["credentials"],
    retention: "Kept while the provider is listed; uploads that were never submitted are removed after 24 hours.",
    processors: ["supabase"],
  },
  {
    key: "pilot_signups",
    label: "Pilot / demo sign-ups from the website",
    owner: "user",
    tables: ["pilot_signups"],
    retention: "Deleted after 24 months.",
    retentionEnv: "RETENTION_PILOT_SIGNUP_MONTHS",
    processors: ["supabase"],
  },
  {
    // 037: Google Meet for video appointments. The provider's Google grant (refresh token, AES-256-GCM encrypted, never
    // sent to a browser) and the Meet link / calendar event id on each video appointment. The calendar event holds
    // the time, `DoctorNearMe video consultation` and an app link only: no child data, no guardian email (D-5).
    key: "google_meet",
    label: "Video calls: providers' Google Calendar connections and Google Meet links",
    owner: "user",
    tables: ["provider_google_connections", "appointments.meet_url", "appointments.google_event_id", "appointments.meet_status", "outbox_job_attempts"],
    retention:
      "A provider's Google connection is kept until they disconnect it (the token is then revoked at Google and deleted). Meet links stay with the appointment record; a cancelled video appointment's calendar event is deleted from the provider's calendar.",
    processors: ["supabase", "google"],
    export: async ({ sql, childId, guardianUserId }) => {
      // The links the guardian can already see on /family/appointments.
      const rows = await sql`
        select id as appointment_id, meet_status, meet_url
        from public.appointments
        where child_id = ${childId} and guardian_user_id = ${guardianUserId} and service_snapshot ->> 'mode' = 'video'
          and status not in ('held', 'expired')
        order by lower(slot)`;
      return { data: rowsJson(rows) };
    },
    // Erasure: the `appointments` category cancels the child's future appointments; their `appointment.cancelled`
    // events enqueue `meet.delete`, which removes the calendar events. Links and event ids carry no child data.
  },
];

/** For modules that prefer to register themselves (call once at module load; keys must be unique). */
export function registerPrivacyCategory(category: PrivacyCategory): void {
  if (REGISTRY.some((c) => c.key === category.key)) throw new Error(`Privacy category already registered: ${category.key}`);
  REGISTRY.push(category);
}

export function categoriesForScope(scope: DeletionScope): PrivacyCategory[] {
  return REGISTRY.filter((c) => c.erase?.scopes.includes(scope));
}
