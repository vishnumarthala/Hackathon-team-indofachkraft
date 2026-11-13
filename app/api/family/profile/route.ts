import { z } from "zod";
import { audit } from "@/lib/audit";
import { PROFILE_COLUMNS, requireGuardian } from "@/lib/authz";
import { supabaseAdmin } from "@/lib/db";
import { fail, ok, parseJson } from "@/lib/http";
import { LOCALE_COOKIE, LOCALES, PREFERENCE_COOKIE_MAX_AGE } from "@/lib/i18n/config";

export const dynamic = "force-dynamic";

const NAME_ERROR = "Enter a name between 1 and 80 characters.";

// `.strict()`: unknown keys (e.g. `role`) are a 400, so no client path can touch privileged columns.
const profileUpdateSchema = z
  .object({
    display_name: z.string().trim().min(1, NAME_ERROR).max(80, NAME_ERROR).optional(),
    preferred_locale: z.enum(LOCALES).optional(),
  })
  .strict()
  .refine((body) => body.display_name !== undefined || body.preferred_locale !== undefined, {
    message: "Nothing to update",
  });

export async function GET() {
  const session = await requireGuardian();
  if (session instanceof Response) return session;
  return ok({ profile: session.profile });
}

// 019 FR-8: the signed-in guardian updates their own name / language.
export async function PATCH(req: Request) {
  const session = await requireGuardian();
  if (session instanceof Response) return session;
  const parsed = await parseJson(req, profileUpdateSchema);
  if ("response" in parsed) return parsed.response;

  const { data, error } = await supabaseAdmin()
    .from("user_profiles")
    .update(parsed.data)
    .eq("id", session.user.id)
    .eq("role", "guardian")
    .select(PROFILE_COLUMNS)
    .single();
  if (error || !data) return fail(500, "Could not save your profile");

  await audit({
    actorUserId: session.user.id,
    action: "guardian.profile_updated",
    entity: "user_profile",
    entityId: session.user.id,
    details: { fields: Object.keys(parsed.data).sort() },
  });

  const response = ok({ profile: data });
  if (parsed.data.preferred_locale) {
    response.cookies.set(LOCALE_COOKIE, parsed.data.preferred_locale, {
      path: "/",
      sameSite: "lax",
      maxAge: PREFERENCE_COOKIE_MAX_AGE,
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
    });
  }
  return response;
}
