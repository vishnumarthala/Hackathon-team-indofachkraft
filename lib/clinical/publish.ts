// Ticket 024 FR-3 (design rule 9): published versions, the one authoritative representation of a clinical
// document that leaves the provider's drafting tools (guardian portal, sharing grants, follow-up agent).
// Server only.
//
// Rules:
// - `content_md` is authoritative. Draft/AI fields (e.g. `reports.content` jsonb) are inputs, never shown as the
//   published document.
// - `published_versions` is append-only (update/delete raise; rows go only with their case). Versions are
//   1, 2, 3, ... per (entity_type, entity_id); the latest version is current.
// - `publishVersion(tx, input)` (SQL `publish_version(jsonb)`) is the ONLY writer. Call it inside the
//   transaction that changes the entity, so the change and its published version commit together.
//   Reports do this through the SQL trigger `reports_publish_final` (a report becoming `final` publishes,
//   with `published_by` from `setActor(tx, userId)`).
// - Readers for guardians use `visible_to_guardian = true` only; readers for other organisations go through
//   a sharing grant (lib/sharing/loaders/*).
import { createHash } from "node:crypto";
import type postgres from "postgres";

export const PUBLISHED_ENTITY_TYPES = ["report", "iep_plan", "home_program", "prescription", "assessment"] as const;
export type PublishedEntityType = (typeof PUBLISHED_ENTITY_TYPES)[number];

export type PublishedVersion = {
  id: string;
  entity_type: PublishedEntityType;
  entity_id: string;
  version: number;
  child_id: string;
  case_id: string | null;
  org_id: string;
  content_md: string;
  content_hash: string;
  visible_to_guardian: boolean;
  published_by: string | null;
  published_at: string;
};

export type PublishInput = {
  entityType: PublishedEntityType;
  entityId: string;
  contentMd: string;
  visibleToGuardian: boolean;
  /** With a case, child and org are taken from (and must match) the case. */
  caseId?: string | null;
  childId?: string | null;
  orgId?: string | null;
  /** Defaults to the transaction's actor (`setActor`). */
  publishedBy?: string | null;
};

type Tx = postgres.Sql | postgres.TransactionSql;

/** sha256 hex of the UTF-8 content, the same as `content_hash`. */
export function contentHash(contentMd: string): string {
  return createHash("sha256").update(contentMd, "utf8").digest("hex");
}

/** Records who acts in this transaction (`app.actor_user_id`), used as `published_by` by SQL publishers. */
export async function setActor(tx: Tx, userId: string): Promise<void> {
  await tx`select set_config('app.actor_user_id', ${userId}, true)`;
}

function toRow(row: Record<string, unknown>): PublishedVersion {
  const at = row.published_at;
  return { ...(row as PublishedVersion), published_at: at instanceof Date ? at.toISOString() : String(at) };
}

/** Publishes the next version of an entity inside `tx`. Throws on invalid input (nothing is written). */
export async function publishVersion(tx: Tx, input: PublishInput): Promise<PublishedVersion> {
  const payload = {
    entity_type: input.entityType,
    entity_id: input.entityId,
    content_md: input.contentMd,
    visible_to_guardian: input.visibleToGuardian,
    case_id: input.caseId ?? null,
    child_id: input.childId ?? null,
    org_id: input.orgId ?? null,
    published_by: input.publishedBy ?? null,
  };
  const rows = await tx<Record<string, unknown>[]>`select * from public.publish_version(${tx.json(payload)}::jsonb)`;
  return toRow(rows[0]);
}

/** Latest published version of an entity, or null. */
export async function getLatestPublished(tx: Tx, entityType: PublishedEntityType, entityId: string): Promise<PublishedVersion | null> {
  const rows = await tx<Record<string, unknown>[]>`
    select * from published_versions
    where entity_type = ${entityType} and entity_id = ${entityId}
    order by version desc limit 1`;
  return rows[0] ? toRow(rows[0]) : null;
}

/** All versions of an entity, newest first. */
export async function listPublishedVersions(tx: Tx, entityType: PublishedEntityType, entityId: string): Promise<PublishedVersion[]> {
  const rows = await tx<Record<string, unknown>[]>`
    select * from published_versions
    where entity_type = ${entityType} and entity_id = ${entityId}
    order by version desc`;
  return rows.map(toRow);
}

/**
 * Current versions of a child's entities that the guardian may see: per entity the LATEST version, kept only if
 * it is `visible_to_guardian` (a newer hidden version withdraws an older visible one). Optionally one entity
 * type. The caller must have checked the guardian's active link to the child (requireChildGuardian[Page]).
 */
export async function listGuardianVisible(tx: Tx, childId: string, entityType?: PublishedEntityType): Promise<PublishedVersion[]> {
  const rows = await tx<Record<string, unknown>[]>`
    select * from (
      select distinct on (entity_type, entity_id) *
      from published_versions
      where child_id = ${childId}
        ${entityType ? tx`and entity_type = ${entityType}` : tx``}
      order by entity_type, entity_id, version desc
    ) latest
    where visible_to_guardian
    order by published_at desc`;
  return rows.map(toRow);
}
