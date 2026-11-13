import { auditActorOf, AuditWriteError, auditFailure } from "@/lib/audit";
import { requireProviderApi } from "@/lib/authz";
import { AttendancePolicySchema, getAttendancePolicy, setAttendancePolicy } from "@/lib/booking/attendance";
import { isUuid } from "@/lib/cases/validation";
import { fail, ok, parseJson } from "@/lib/http";
import { canManage, getMembershipRole } from "@/lib/orgs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function gate(id: string) {
  const g = await requireProviderApi();
  if ("response" in g) return g;
  if (!isUuid(id)) return { response: fail(404, "Organisation not found") };
  const role = await getMembershipRole(g.actor.user.id, id);
  if (!role) return { response: fail(404, "Organisation not found") };
  return { actor: g.actor, role };
}

// 044 FR-2: the organisation's attendance billing rules. Members read them; owner/admin change them (members 403,
// non-members 404).
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const g = await gate(id);
  if ("response" in g) return g.response;
  return ok({ policy: await getAttendancePolicy(id) });
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const g = await gate(id);
  if ("response" in g) return g.response;
  if (!canManage(g.role)) return fail(403, "Only organisation owners and admins can change attendance rules");
  const parsed = await parseJson(req, AttendancePolicySchema);
  if ("response" in parsed) return parsed.response;
  try {
    const policy = await setAttendancePolicy(id, parsed.data, { ...auditActorOf(g.actor.user, g.actor.role), actorUserId: g.actor.user.id });
    return ok({ policy });
  } catch (err) {
    if (err instanceof AuditWriteError) return auditFailure(err);
    throw err;
  }
}
