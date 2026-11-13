import { z } from "zod";
import { audit } from "@/lib/audit";
import { getAuthenticatedUser, getUserRole } from "@/lib/auth";
import { fail, ok, parseJson } from "@/lib/http";
import { getPreferences, setPreferences } from "@/lib/notify/inbox";

export const dynamic = "force-dynamic";

const schema = z.object({ email: z.boolean(), whatsapp: z.boolean() }).strict();

export async function GET() {
  const user = await getAuthenticatedUser();
  if (!user) return fail(401, "Authentication required");
  return ok({ preferences: await getPreferences(user.id) });
}

// FR-8: the caller's own email / WhatsApp switches (in-app cannot be turned off).
export async function PUT(req: Request) {
  const user = await getAuthenticatedUser();
  if (!user) return fail(401, "Authentication required");
  const parsed = await parseJson(req, schema);
  if ("response" in parsed) return parsed.response;
  const preferences = await setPreferences(user.id, parsed.data);
  const role = await getUserRole(user.id);
  await audit({
    actor: role === "guardian" ? "parent" : "therapist",
    actorUserId: user.id,
    action: "notification.preferences_updated",
    entity: "user_profile",
    entityId: user.id,
    details: preferences,
  });
  return ok({ preferences });
}
