import { requireGuardian } from "@/lib/authz";
import { ChildCreateSchema, childJson, createGuardianChild, listGuardianChildren } from "@/lib/children";
import { fail, ok, parseJson } from "@/lib/http";

export const dynamic = "force-dynamic";

// 020 FR-11: the guardian's linked children.
export async function GET() {
  const session = await requireGuardian();
  if (session instanceof Response) return session;
  const rows = await listGuardianChildren(session.user.id);
  return ok({ children: rows.map(({ child, link }) => ({ ...childJson(child), relationship: link.relationship })) });
}

// 020 FR-11: add a child with the "I am this child's parent or legal guardian." declaration.
export async function POST(req: Request) {
  const session = await requireGuardian();
  if (session instanceof Response) return session;
  const parsed = await parseJson(req, ChildCreateSchema);
  if ("response" in parsed) return parsed.response;
  const body = parsed.data;
  try {
    const child = await createGuardianChild({
      userId: session.user.id,
      displayName: body.display_name,
      dateOfBirth: body.date_of_birth ?? null,
      sex: body.sex ?? null,
      relationship: body.relationship,
    });
    return ok({ child: childJson(child) }, 201);
  } catch (err) {
    console.error(`add child failed: ${err instanceof Error ? err.message : String(err)}`);
    return fail(503, "Could not save. Please try again.");
  }
}
