import { z } from "zod";
import { auditActorOf, auditFailure } from "@/lib/audit";
import { requirePlatformAdminApi } from "@/lib/authz";
import { isUuid } from "@/lib/cases/validation";
import { fail, ok, parseJson } from "@/lib/http";
import { reviewDeletionRequest } from "@/lib/privacy/deletion";
import { runPrivacyJobsSoon } from "@/lib/privacy/jobs";

export const dynamic = "force-dynamic";

const REJECT_NOTE_REQUIRED = "Explain why (at least 10 characters), citing the record-keeping obligation";

const ReviewSchema = z
  .object({
    decision: z.enum(["approve", "reject"], { error: "Choose approve or reject" }),
    note: z.string().trim().max(1000, { error: "Note must be at most 1000 characters" }).optional(),
  })
  .refine((v) => v.decision === "approve" || (v.note?.length ?? 0) >= 10, { path: ["note"], error: REJECT_NOTE_REQUIRED });

// 041 FR-8 / D-5: platform admin approves (job runs right away) or rejects with a cited reason. Others: 401/403.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePlatformAdminApi();
  if ("response" in gate) return gate.response;
  const { id } = await params;
  if (!isUuid(id)) return fail(404, "Request not found");
  const parsed = await parseJson(req, ReviewSchema);
  if ("response" in parsed) return parsed.response;
  let result: Awaited<ReturnType<typeof reviewDeletionRequest>>;
  try {
    result = await reviewDeletionRequest(id, parsed.data.decision, parsed.data.note ?? null, auditActorOf(gate.actor.user, gate.actor.role));
  } catch (err) {
    return auditFailure(err);
  }
  if (!result.ok) return fail(result.status, result.error);
  if (result.request.status === "approved") runPrivacyJobsSoon({ deletionIds: [id] });
  return ok({ id, status: result.request.status });
}
