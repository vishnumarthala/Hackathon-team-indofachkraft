// Ticket 035 FR-4: start an appointment-bound intake call. Public by design: the 43-character token is the capability
// (only its hash is stored). Re-checks the link (expired at the appointment start, revoked on cancel / consent
// withdrawal: 410) and ai_intake_call consent (422) on every start. Dynamic variables carry `intake_attempt_id`,
// never the case id. 049: the generic agent speaks the call language too (`language`, default the viewer's UI
// locale) when it is enabled (ELEVENLABS_GENERIC_INTAKE_LANGUAGES); otherwise 409 `language_unavailable` and the page
// offers "Voice in English" or skipping the call. The Child Development agent is unchanged.
import { z } from "zod";
import { resolveCallLanguage } from "@/lib/agents/call-language";
import { audit } from "@/lib/audit";
import { requireConsent } from "@/lib/consent";
import { isDemoMode } from "@/lib/demo";
import { startAgentSession, type AgentStart } from "@/lib/elevenlabs/agent";
import { fail, ok, parseJson } from "@/lib/http";
import { agentIdFor, attemptLinkState, getAttemptByToken, markAttemptStarted } from "@/lib/intake/attempts";
import { LINK_EXPIRED } from "@/lib/intake/link";
import { LanguageSchema } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({ language: LanguageSchema.optional() });
/** The published Child Development agent requires `case_id`; appointment calls send this placeholder instead. */
const APPOINTMENT_CASE_PLACEHOLDER = "appointment-intake";

export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const attempt = await getAttemptByToken(token);
  if (!attempt) return fail(404, "This link is not valid.");
  const state = attemptLinkState(attempt);
  if (state === "completed") return fail(409, "This intake call is already complete");
  if (state !== "active" || !attempt.child_id) return fail(410, LINK_EXPIRED);
  const blocked = await requireConsent(attempt.child_id, "ai_intake_call");
  if (blocked) return blocked;

  const parsed = await parseJson(req, bodySchema);
  if ("response" in parsed) return parsed.response;
  // The Child Development agent speaks the language the parent picked (or the case language); the generic agent the
  // call language when it is enabled on that agent.
  let language = parsed.data.language ?? attempt.case_language;
  if (attempt.agent_kind === "generic") {
    const call = await resolveCallLanguage("generic_intake", parsed.data.language);
    if (!call.ok) return call.response;
    language = call.language;
  }

  await markAttemptStarted(attempt.id);
  const started = (demo: boolean) =>
    audit({
      caseId: attempt.case_id,
      actor: "parent",
      action: "intake.started",
      entity: "intake_attempt",
      entityId: attempt.id,
      details: { language, demo, agent_kind: attempt.agent_kind, appointment_id: attempt.appointment_id },
    });

  if (isDemoMode()) {
    await started(true);
    return ok(attempt.agent_kind === "generic" ? { demo: true, language } : { demo: true });
  }

  const agentId = agentIdFor(attempt.agent_kind);
  if (!agentId) return fail(503, "Could not start the call");
  let session: AgentStart;
  try {
    session = await startAgentSession(agentId, attempt.agent_kind === "generic" ? { language } : {});
  } catch (err) {
    console.error(`appointment intake start failed: ${err instanceof Error ? err.message : String(err)}`);
    return fail(502, "Could not start the call");
  }

  await started(false);
  const childName = attempt.child_name ?? "your child";
  const parentName = attempt.guardian_name ?? "Parent";
  const common = {
    child_name: childName,
    parent_name: parentName,
    centre_name: attempt.org_name,
    // Our completion/webhook processing finds the appointment by this id (FR-4); never the case id.
    intake_attempt_id: attempt.id,
    language,
  };
  return ok({
    conversation_token: session.conversation_token,
    agent_id: session.agent_id,
    ...(attempt.agent_kind === "generic" ? { language } : {}),
    dynamic_variables:
      attempt.agent_kind === "generic"
        ? { ...common, provider_name: attempt.provider_name, service_name: attempt.service_name }
        : {
            ...common,
            therapist_name: attempt.provider_name,
            case_id: APPOINTMENT_CASE_PLACEHOLDER,
            child_alias: childName,
            parent_alias: parentName,
          },
  });
}
