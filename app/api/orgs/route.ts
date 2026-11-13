import { audit } from "@/lib/audit";
import { requireProviderApi } from "@/lib/authz";
import { ok, parseJson } from "@/lib/http";
import { createOrganization, OrgCreateSchema } from "@/lib/orgs";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const gate = await requireProviderApi();
  if ("response" in gate) return gate.response;
  const userId = gate.actor.user.id;

  const parsed = await parseJson(req, OrgCreateSchema);
  if ("response" in parsed) return parsed.response;

  const org = await createOrganization(userId, parsed.data);
  await audit({
    actorUserId: userId,
    action: "org.created",
    entity: "organization",
    entityId: org.id,
    details: { kind: org.kind },
  });
  return ok({ org }, 201);
}
