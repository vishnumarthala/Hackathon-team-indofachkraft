import { audit } from "@/lib/audit";
import { requireProviderProfileOwner } from "@/lib/authz";
import { fail, ok, parseJson } from "@/lib/http";
import { invalidatePublicProviders } from "@/lib/providers/public";
import { CredentialSubmitSchema } from "@/lib/providers/schemas";
import { checkCertificate, submitCredentials } from "@/lib/providers/verification";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// FR-3 `Submit for verification`: the profile becomes `pending` and unlisted until a platform admin decides.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireProviderProfileOwner(id);
  if ("response" in gate) return gate.response;

  const parsed = await parseJson(req, CredentialSubmitSchema);
  if ("response" in parsed) return parsed.response;

  const certificate = await checkCertificate(id, parsed.data.certificate_path);
  if (!certificate.ok) return fail(certificate.status, "Invalid request", { certificate_path: certificate.error });

  const result = await submitCredentials(id, gate.actor.user.id, parsed.data);
  if (!result.ok) return fail(result.status, result.error);
  await audit({
    actor: "therapist",
    actorUserId: gate.actor.user.id,
    action: "provider.credentials_submitted",
    entity: "credential_submission",
    entityId: result.data.submissionId,
    details: { provider_profile_id: id, council: parsed.data.council },
  });
  invalidatePublicProviders();
  return ok({ submission_id: result.data.submissionId, verification_status: "pending" }, 201);
}
