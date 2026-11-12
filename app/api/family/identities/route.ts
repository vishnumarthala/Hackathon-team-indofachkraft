import { z } from "zod";
import { audit } from "@/lib/audit";
import { requireGuardian } from "@/lib/authz";
import { canUnlink, signInMethods, UNLINK_LAST_METHOD_ERROR } from "@/lib/family/identities";
import { redactPhones } from "@/lib/family/phone";
import { fail, ok, parseJson } from "@/lib/http";
import { supabaseRouteClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

const schema = z.object({ provider: z.enum(["google", "phone"]) }).strict();

export async function GET() {
  const session = await requireGuardian();
  if (session instanceof Response) return session;
  return ok({ methods: signInMethods(session.user) });
}

// 019 FR-9: unlink a sign-in method, only while another one remains. Uses the guardian's own session.
export async function DELETE(req: Request) {
  const session = await requireGuardian();
  if (session instanceof Response) return session;
  const parsed = await parseJson(req, schema);
  if ("response" in parsed) return parsed.response;
  const { provider } = parsed.data;

  if (!canUnlink(signInMethods(session.user), provider)) return fail(409, UNLINK_LAST_METHOD_ERROR);

  const client = await supabaseRouteClient();
  const identities = await client.auth.getUserIdentities();
  const identity = identities.data?.identities.find((item) => item.provider === provider);
  if (identities.error) return fail(502, "Could not remove this sign-in method. Please try again.");
  if (!identity) return fail(404, "Sign-in method not found");
  const { error } = await client.auth.unlinkIdentity(identity);
  if (error) {
    console.error(`[identities] unlink ${provider} failed: ${redactPhones(error.message)}`);
    return fail(502, "Could not remove this sign-in method. Please try again.");
  }

  await audit({
    actor: "parent",
    actorUserId: session.user.id,
    action: "guardian.identity_unlinked",
    entity: "user",
    entityId: session.user.id,
    details: { provider },
  });
  return ok({ unlinked: provider });
}
