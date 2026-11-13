import { z } from "zod";
import { auditActorOf, auditFailure, AuditWriteError } from "@/lib/audit";
import { requireProviderApi } from "@/lib/authz";
import { isUuid } from "@/lib/cases/validation";
import { normalizeMeetUrl, setManualMeetLink } from "@/lib/google/meet";
import { fail, ok, parseJson } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ url: z.string().max(300) });

// 037 FR-4 `Add a video link`: the provider side of the appointment (profile owner or an org owner/admin) pastes a
// `https://meet.google.com/...` link when the automatic one failed. Others' appointments -> 404; a non-Meet URL -> 400;
// not a confirmed video appointment without a link -> 409.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireProviderApi();
  if ("response" in gate) return gate.response;
  if (!isUuid(id)) return fail(404, "Appointment not found");
  const parsed = await parseJson(req, Body);
  if ("response" in parsed) return parsed.response;
  const meetUrl = normalizeMeetUrl(parsed.data.url);
  if (!meetUrl) return fail(400, "Invalid request", { url: "Paste a Google Meet link (https://meet.google.com/...)" });
  try {
    const result = await setManualMeetLink({
      appointmentId: id,
      meetUrl,
      actor: auditActorOf(gate.actor.user, gate.actor.role),
    });
    if (!result.ok && result.code === "not_found") return fail(404, "Appointment not found");
    if (!result.ok) return fail(409, result.code === "not_video" ? "This is not a video appointment." : "A video link cannot be added to this appointment now.");
    return ok({ meet_url: result.meet_url, meet_status: "manual" });
  } catch (err) {
    if (err instanceof AuditWriteError) return auditFailure(err);
    throw err;
  }
}
