import { requireChildGuardian, requireGuardian } from "@/lib/authz";
import { fail, ok, parseJson } from "@/lib/http";
import { createSharingGrant, GrantCreateSchema, listActiveChildGrants } from "@/lib/sharing/grants";

export const dynamic = "force-dynamic";

// 022 FR-5: the child's sharing grants that are still in force.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireGuardian();
  if (session instanceof Response) return session;
  const { id } = await params;
  const access = await requireChildGuardian(id, session);
  if (access instanceof Response) return access;
  return ok({ grants: await listActiveChildGrants(access.child.id) });
}

// 022 FR-5 (D-2, D-4): only a linked guardian shares a child's records from one treating org to another.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireGuardian();
  if (session instanceof Response) return session;
  const { id } = await params;
  const access = await requireChildGuardian(id, session);
  if (access instanceof Response) return access;

  const parsed = await parseJson(req, GrantCreateSchema);
  if ("response" in parsed) return parsed.response;
  const result = await createSharingGrant(access.child.id, session.user.id, parsed.data);
  if (!result.ok) return fail(result.status, result.error);
  return ok({ grant: result.data }, 201);
}
