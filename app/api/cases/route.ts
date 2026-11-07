import { audit } from "@/lib/audit";
import { requireApiUser } from "@/lib/auth";
import { caseCreateSchema } from "@/lib/cases/validation";
import { supabaseAdmin } from "@/lib/db";
import { fail, ok, parseJson } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const unauthorized = await requireApiUser();
  if (unauthorized) return unauthorized;

  const parsed = await parseJson(req, caseCreateSchema);
  if ("response" in parsed) return parsed.response;

  const { data, error } = await supabaseAdmin().from("cases").insert(parsed.data).select("*").single();
  if (error || !data) return fail(500, "Could not create the case");

  await audit({ caseId: data.id, actor: "therapist", action: "case.created", entity: "case", entityId: data.id });
  return ok({ case: data }, 201);
}
