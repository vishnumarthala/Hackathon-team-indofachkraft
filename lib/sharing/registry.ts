// Ticket 022 FR-6: what a sharing grant makes visible, per scope. Server only.
//
// Each feature that owns a share scope registers ONE loader here (tickets 023 documents, 024 assessments/reports,
// 025 iep, 026 home_program, 021 health_profile). A loader only reads; callers have already checked the grant
// with `requireSharedAccess()` / `getActiveGrants()` and pass the source organisations it allows.
//
// Loader contract:
// - `list` and `get` MUST filter in SQL by `ctx.childId` AND `ctx.sourceOrgIds` (NFR-1): never fetch-all.
// - Return only items that are safe to share (e.g. finalised, not drafts).
// - `get` returns null for anything outside the context (wrong child, other org, draft, missing id).
// - `sourceOrgId` on every item says which grant covers it (used for the `sharing.viewed` audit).
//
// To add a scope: create `lib/sharing/loaders/<scope>.ts` exporting a `ShareLoader`, add one line to
// `SHARE_LOADERS` below, and add tests (see tests/sharing-grants.test.ts for the reports loader).
import { assessmentsLoader } from "@/lib/sharing/loaders/assessments";
import { documentsLoader } from "@/lib/sharing/loaders/documents";
import { healthProfileLoader } from "@/lib/sharing/loaders/health_profile";
import { iepLoader } from "@/lib/sharing/loaders/iep";
import { reportsLoader } from "@/lib/sharing/loaders/reports";
import type { ShareScope } from "@/lib/sharing/scopes";

export type ShareContext = { childId: string; sourceOrgIds: string[] };

export type SharedItem = {
  id: string;
  sourceOrgId: string;
  /** Item title as stored (user/clinical content, not translated). */
  title: string;
  /** ISO timestamp shown as the item date. */
  date: string;
};

export type SharedItemBody =
  | { kind: "markdown"; markdown: string }
  | { kind: "file"; url: string; fileName: string; mimeType: string };

export type SharedItemDetail = SharedItem & { body: SharedItemBody };

export type ShareLoader = {
  list(ctx: ShareContext): Promise<SharedItem[]>;
  get(ctx: ShareContext, itemId: string): Promise<SharedItemDetail | null>;
};

export const SHARE_LOADERS: Partial<Record<ShareScope, ShareLoader>> = {
  reports: reportsLoader,
  assessments: assessmentsLoader,
  documents: documentsLoader,
  health_profile: healthProfileLoader,
  iep: iepLoader,
};

export function getShareLoader(scope: ShareScope): ShareLoader | null {
  return SHARE_LOADERS[scope] ?? null;
}
