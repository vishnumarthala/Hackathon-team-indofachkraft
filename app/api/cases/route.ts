import { audit } from "@/lib/audit";
import { requireProviderApi } from "@/lib/authz";
import { caseCreateSchema } from "@/lib/cases/validation";
import { supabaseAdmin } from "@/lib/db";
import { fail, ok, parseJson } from "@/lib/http";
import { resolveCaseOrg } from "@/lib/orgs";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const gate = await requireProviderApi();
  if ("response" in gate) return gate.response;
  const userId = gate.actor.user.id;

  const parsed = await parseJson(req, caseCreateSchema);
  if ("response" in parsed) return parsed.response;
  const { org_id: requestedOrg, ...fields } = parsed.data;

  const org = await resolveCaseOrg(userId, requestedOrg);
  if (!org.ok) return fail(org.status, org.error);

  const { data, error } = await supabaseAdmin()
    .from("cases")
    .insert({ ...fields, org_id: org.data, created_by: userId })
    .select("*")
    .single();
  if (error || !data) return fail(500, "Could not create the case");

  await audit({
    caseId: data.id,
    actorUserId: userId,
    action: "case.created",
    entity: "case",
    entityId: data.id,
    details: { org_id: org.data },
  });
  return ok({ case: data }, 201);
}
