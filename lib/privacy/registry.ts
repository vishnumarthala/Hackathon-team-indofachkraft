// 041 FR-5: the privacy registry. Every category of personal data the app stores is listed here once, with its owner,
// storage, retention rule, the processors that receive it, and how it is exported (FR-7) and erased (FR-8).
// lib/privacy/export.ts, lib/privacy/deletion.ts, the privacy notice (/privacy) and docs/privacy/retention.md are all
// driven by this list. The scheduled retention steps are in lib/privacy/retention.ts (keyed by the same `key`).
//
// Extending (024 assessments, 025 IEP, 026 home program, 027 messages, M2/M3 tickets): append an entry to
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
export type Processor = "elevenlabs" | "gemini" | "resend" | "whatsapp" | "supabase";
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
];

/** For modules that prefer to register themselves (call once at module load; keys must be unique). */
export function registerPrivacyCategory(category: PrivacyCategory): void {
  if (REGISTRY.some((c) => c.key === category.key)) throw new Error(`Privacy category already registered: ${category.key}`);
  REGISTRY.push(category);
}

export function categoriesForScope(scope: DeletionScope): PrivacyCategory[] {
  return REGISTRY.filter((c) => c.erase?.scopes.includes(scope));
}
