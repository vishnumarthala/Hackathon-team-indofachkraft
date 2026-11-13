import { z } from "zod";
import { auditFailure, AuditWriteError } from "@/lib/audit";
import { requireIepGoalActor } from "@/lib/authz";
import { fail, ok, parseJson } from "@/lib/http";
import { acceptGoalSuggestion, rejectGoalSuggestion, suggestionTarget, SUGGESTION_MESSAGES } from "@/lib/scribe/suggestions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DecisionSchema = z
  .object({
    status: z.enum(["accepted", "rejected"], { error: "Status must be accepted or rejected" }),
    // `Edit value`: the clinician's value instead of the suggestion (accept only).
    value: z.number({ error: "Value must be a number" }).finite().optional(),
  })
  .strict()
  .refine((b) => b.status === "accepted" || b.value === undefined, { message: "A value can only be given when accepting", path: ["value"] });

// 038 FR-5: `Accept` (creates goal_progress with source `ai_suggested_confirmed` and the recording, 025
// recordProgress) / `Edit value` (accept with `value`) / `Reject` (no progress row). Access = 025's goal gate
// (requireIepGoalActor: case access through the goal's plan); other organisations' ids -> 404.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const target = await suggestionTarget(id);
  if (!target) return fail(404, SUGGESTION_MESSAGES.notFound);
  const gate = await requireIepGoalActor(target.goal_id, SUGGESTION_MESSAGES.notFound);
  if ("response" in gate) return gate.response;
  if (gate.caseId !== target.case_id) return fail(404, SUGGESTION_MESSAGES.notFound);

  const parsed = await parseJson(req, DecisionSchema);
  if ("response" in parsed) return parsed.response;
  try {
    const result =
      parsed.data.status === "accepted"
        ? await acceptGoalSuggestion({ suggestionId: id, actorUserId: gate.actor.user.id, value: parsed.data.value })
        : await rejectGoalSuggestion({ suggestionId: id, actorUserId: gate.actor.user.id });
    if (!result.ok) return fail(result.status, result.error, result.details);
    return ok(result);
  } catch (err) {
    if (err instanceof AuditWriteError) return auditFailure(err);
    console.error(`goal suggestion decision failed for ${id}: ${err instanceof Error ? err.message : String(err)}`);
    return fail(500, "Could not save the decision");
  }
}
