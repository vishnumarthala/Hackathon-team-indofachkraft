import { audit } from "@/lib/audit";
import { caseUpdateSchema, changedFields, hasUpdates } from "@/lib/cases/validation";
import { supabaseAdmin } from "@/lib/db";
import { fail, ok, parseJson } from "@/lib/http";
import { getCase } from "@/lib/queries/cases";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const current = await getCase(id);
  if (!current) return fail(404, "Case not found");

  const parsed = await parseJson(req, caseUpdateSchema);
  if ("response" in parsed) return parsed.response;
  if (!hasUpdates(parsed.data)) return fail(400, "Nothing to update");

  const changed = changedFields(current, parsed.data);
  if (changed.length === 0) return ok({ case: current });

  const update = Object.fromEntries(changed.map((field) => [field, parsed.data[field]]));
  const { data, error } = await supabaseAdmin().from("cases").update(update).eq("id", id).select("*").single();
  if (error || !data) return fail(500, "Could not update the case");

  await audit({
    caseId: id,
    actor: "therapist",
    action: "case.updated",
    entity: "case",
    entityId: id,
    details: { changed },
  });
  return ok({ case: data });
}
