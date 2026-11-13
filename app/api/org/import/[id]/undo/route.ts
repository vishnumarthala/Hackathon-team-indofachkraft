import { auditActorOf, AuditWriteError, auditFailure } from "@/lib/audit";
import { fail, ok } from "@/lib/http";
import { requireImportAccess, undoImport } from "@/lib/import/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 047 FR-5: undo within 24 h, only while nothing was added to the imported children and cases.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireImportAccess(id);
  if ("response" in gate) return gate.response;
  const actor = { ...auditActorOf(gate.actor.user, gate.actor.role), actorUserId: gate.actor.user.id };
  let outcome: Awaited<ReturnType<typeof undoImport>>;
  try {
    outcome = await undoImport(id, actor);
  } catch (err) {
    if (err instanceof AuditWriteError) return auditFailure(err);
    console.error(`child import undo failed: ${err instanceof Error ? err.message : String(err)}`);
    return fail(503, "Could not undo. Nothing was changed. Please try again.");
  }
  switch (outcome.result) {
    case "undone":
      return ok(outcome);
    case "blocked":
      return fail(
        409,
        `Cannot undo: something was added to the children in rows ${outcome.blocked_rows.join(", ")} since the import`,
        { blocked_rows: outcome.blocked_rows },
      );
    case "expired":
      return fail(409, "The 24-hour undo window has passed");
    case "already_undone":
      return fail(409, "This import was already undone");
    default:
      return fail(404, "Import not found");
  }
}
