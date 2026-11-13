import { z } from "zod";
import { auditActorOf, auditFailure } from "@/lib/audit";
import { requireChildGuardian, requireGuardian } from "@/lib/authz";
import { fail, ok, parseJson } from "@/lib/http";
import { createDeletionRequest, DELETION_SCOPES, listChildDeletionRequests, type DeletionRequestRow } from "@/lib/privacy/deletion";

export const dynamic = "force-dynamic";

const DeletionRequestSchema = z.object({
  scope: z.enum(DELETION_SCOPES, { error: "Choose what to delete" }),
  reason: z.string().trim().max(1000, { error: "Reason must be at most 1000 characters" }).optional(),
});

function deletionJson(row: DeletionRequestRow) {
  return {
    id: row.id,
    scope: row.scope,
    status: row.status,
    review_note: row.status === "rejected" ? row.review_note : null,
    created_at: row.created_at,
    reviewed_at: row.reviewed_at,
    completed_at: row.completed_at,
  };
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireGuardian();
  if (session instanceof Response) return session;
  const access = await requireChildGuardian((await params).id, session);
  if (access instanceof Response) return access;
  return ok({ requests: (await listChildDeletionRequests(access.child.id)).map(deletionJson) });
}

// 041 FR-8: 201; one open request per child (409). A platform admin reviews it before anything is deleted.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireGuardian();
  if (session instanceof Response) return session;
  const access = await requireChildGuardian((await params).id, session);
  if (access instanceof Response) return access;
  const parsed = await parseJson(req, DeletionRequestSchema);
  if ("response" in parsed) return parsed.response;
  let result: Awaited<ReturnType<typeof createDeletionRequest>>;
  try {
    result = await createDeletionRequest(
      { childId: access.child.id, guardianUserId: session.user.id, scope: parsed.data.scope, reason: parsed.data.reason },
      auditActorOf(session.user, "guardian"),
    );
  } catch (err) {
    return auditFailure(err);
  }
  if (!result.ok) return fail(result.status, result.error);
  return ok({ request: deletionJson(result.request) }, 201);
}
