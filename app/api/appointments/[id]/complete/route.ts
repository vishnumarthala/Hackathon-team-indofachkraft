import { audit } from "@/lib/audit";
import { requireProviderApi } from "@/lib/authz";
import { withBookingErrors } from "@/lib/booking/errors";
import { CompleteSchema } from "@/lib/booking/schemas";
import { completeAppointment, getAppointment } from "@/lib/booking/store";
import { isUuid } from "@/lib/cases/validation";
import { fail, ok, parseJson } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// FR-4 complete { status: completed | no_show }: provider side only, only after the start (409 before).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireProviderApi();
  if ("response" in gate) return gate.response;
  if (!isUuid(id)) return fail(404, "Appointment not found");
  const parsed = await parseJson(req, CompleteSchema);
  if ("response" in parsed) return parsed.response;

  const result = await withBookingErrors(() => completeAppointment(id, gate.actor.user.id, parsed.data.status));
  if ("response" in result) return result.response;

  const appointment = await getAppointment(id);
  await audit({
    actorUserId: gate.actor.user.id,
    actorRole: gate.actor.role === "platform_admin" ? "platform_admin" : "provider",
    childId: appointment?.child_id ?? null,
    orgId: appointment?.org_id ?? null,
    action: `appointment.${parsed.data.status}`,
    entity: "appointment",
    entityId: id,
  });
  return ok({ appointment });
}
