import { deleteActivity, updateActivity } from "@/lib/home-program";
import { requireHomeActivityActor } from "@/lib/home-program/authz";
import { ActivityPatchSchema } from "@/lib/home-program/schema";
import { fail, ok, parseJson } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 026 FR-2: edit an activity (any field, `sort`, `active`; optional program `version`, stale -> 409).
export async function PATCH(req: Request, { params }: { params: Promise<{ aid: string }> }) {
  const { aid } = await params;
  const gate = await requireHomeActivityActor(aid);
  if ("response" in gate) return gate.response;
  const parsed = await parseJson(req, ActivityPatchSchema);
  if ("response" in parsed) return parsed.response;

  const result = await updateActivity({ activityId: aid, actorUserId: gate.actor.user.id, body: parsed.data });
  if (!result.ok) return fail(result.status, result.error, result.details);
  return ok({ activity: result.activity, program_version: result.program_version });
}

// 026 FR-2: draft programs delete the activity; published programs stop it (`active = false`, logs kept).
// Optional `?version=` (program version).
export async function DELETE(req: Request, { params }: { params: Promise<{ aid: string }> }) {
  const { aid } = await params;
  const gate = await requireHomeActivityActor(aid);
  if ("response" in gate) return gate.response;
  const raw = new URL(req.url).searchParams.get("version");
  const version = raw === null ? null : Number(raw);
  if (version !== null && (!Number.isInteger(version) || version < 1)) {
    return fail(400, "Invalid request", { version: "version must be a positive integer" });
  }

  const result = await deleteActivity({ activityId: aid, actorUserId: gate.actor.user.id, version });
  if (!result.ok) return fail(result.status, result.error, result.details);
  return ok({ deleted: result.deleted, activity: result.activity, program_version: result.program_version });
}
