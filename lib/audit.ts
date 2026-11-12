import { supabaseAdmin } from "@/lib/db";

export type AuditActor = "therapist" | "parent" | "specialist" | "ai" | "system";

export type AuditEvent = {
  caseId?: string | null;
  actor: AuditActor;
  actorUserId?: string | null;
  action: string;
  entity?: string;
  entityId?: string;
  details?: Record<string, unknown>;
};

// Never throws: a failed audit write must not break the user's action.
export async function audit(event: AuditEvent): Promise<void> {
  try {
    const { error } = await supabaseAdmin()
      .from("audit_events")
      .insert({
        case_id: event.caseId ?? null,
        actor: event.actor,
        ...(event.actorUserId ? { actor_user_id: event.actorUserId } : {}),
        action: event.action,
        entity: event.entity ?? null,
        entity_id: event.entityId ?? null,
        details: event.details ?? {},
      });
    if (error) throw new Error(error.message);
  } catch (err) {
    console.error(`audit failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
