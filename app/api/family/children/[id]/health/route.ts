import { requireChildGuardian, requireGuardian } from "@/lib/authz";
import { fail, ok } from "@/lib/http";
import { HEALTH_CONFLICT_ERROR, healthFieldErrors, HealthProfilePutSchema } from "@/lib/health/schema";
import { getHealthProfileOrEmpty, saveHealthProfile } from "@/lib/queries/health";

export const dynamic = "force-dynamic";

// NFR-1: health data is per user; never cached by browsers or proxies.
const noStore = <R extends Response>(res: R): R => {
  res.headers.set("Cache-Control", "private, no-store");
  return res;
};

// 021 FR-3: the child's health profile for a linked guardian (empty profile with version 0 if none).
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireGuardian();
  if (session instanceof Response) return session;
  const { id } = await params;
  const access = await requireChildGuardian(id, session);
  if (access instanceof Response) return access;
  return noStore(ok({ profile: await getHealthProfileOrEmpty(access.child.id) }));
}

// 021 FR-3 (D-2, D-4): guardians replace the whole profile; `version` is the one the editor started from.
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireGuardian();
  if (session instanceof Response) return session;
  const { id } = await params;
  const access = await requireChildGuardian(id, session);
  if (access instanceof Response) return access;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail(400, "Invalid request", { body: "Body must be JSON" });
  }
  const parsed = HealthProfilePutSchema.safeParse(body);
  if (!parsed.success) return fail(400, "Invalid request", healthFieldErrors(parsed.error));
  const { version, ...fields } = parsed.data;

  let saved: Awaited<ReturnType<typeof saveHealthProfile>>;
  try {
    saved = await saveHealthProfile(access.child.id, session.user.id, fields, version);
  } catch (error) {
    // NFR-3: the message names the operation only; no profile values are logged.
    console.error(`[health] save failed for child ${access.child.id}: ${(error as Error).message.slice(0, 200)}`);
    return fail(503, "Could not save the health profile. Please try again.");
  }
  if (saved.result === "not_found") return fail(404, "Child not found");
  if (saved.result === "conflict") return fail(409, HEALTH_CONFLICT_ERROR);
  return noStore(ok({ profile: saved.profile }));
}
