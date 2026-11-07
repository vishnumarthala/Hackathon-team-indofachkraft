import { audit } from "@/lib/audit";
import { supabaseAdmin } from "@/lib/db";
import { fail, ok, parseJson } from "@/lib/http";
import { isHoneypotFilled, PilotSignupSchema } from "@/lib/pilots";

export const dynamic = "force-dynamic";

const UNIQUE_VIOLATION = "23505";

export async function POST(req: Request) {
  const parsed = await parseJson(req, PilotSignupSchema);
  if ("response" in parsed) return parsed.response;
  const input = parsed.data;

  // Honeypot filled: pretend success, save nothing.
  if (isHoneypotFilled(input)) return ok({ ok: true });

  const db = supabaseAdmin();

  // Existing email: same success message, no changes (no account enumeration).
  const existing = await db
    .from("pilot_signups")
    .select("id")
    .eq("email", input.email)
    .maybeSingle();
  if (existing.error) return fail(500, "Could not save your sign-up");
  if (existing.data) return ok({ ok: true });

  const inserted = await db
    .from("pilot_signups")
    .insert({
      name: input.name,
      email: input.email,
      role: input.role,
      country: input.country,
      centre: input.centre ?? null,
      clinicians: input.clinicians ?? null,
      note: input.note ?? null,
    })
    .select("id")
    .single();

  if (inserted.error) {
    // Lost a race with a parallel sign-up for the same email.
    if (inserted.error.code === UNIQUE_VIOLATION) return ok({ ok: true });
    return fail(500, "Could not save your sign-up");
  }

  await audit({
    caseId: null,
    actor: "system",
    action: "pilot.signup",
    entity: "pilot_signup",
    entityId: inserted.data.id,
    details: { role: input.role, country: input.country },
  });

  return ok({ ok: true }, 201);
}
