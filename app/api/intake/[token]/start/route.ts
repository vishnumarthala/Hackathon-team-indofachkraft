import { z } from "zod";
import { audit } from "@/lib/audit";
import { isDemoMode } from "@/lib/demo";
import { DEMO_CENTRE_NAME, startAgentSession, type AgentStart } from "@/lib/elevenlabs/agent";
import { fail, ok, parseJson } from "@/lib/http";
import { getCaseByToken, hasIntakeRecording } from "@/lib/queries/intake";
import { LanguageSchema } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({ language: LanguageSchema });

export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const caseRow = await getCaseByToken(token);
  if (!caseRow) return fail(404, "This link is not valid.");
  if (await hasIntakeRecording(caseRow.id)) return fail(409, "This intake call is already complete");

  const parsed = await parseJson(req, bodySchema);
  if ("response" in parsed) return parsed.response;
  const { language } = parsed.data;

  const started = (demo: boolean) =>
    audit({
      caseId: caseRow.id,
      actor: "parent",
      action: "intake.started",
      entity: "case",
      entityId: caseRow.id,
      details: { language, demo },
    });

  if (isDemoMode()) {
    await started(true);
    return ok({ demo: true });
  }

  let session: AgentStart;
  try {
    session = await startAgentSession();
  } catch (err) {
    console.error(`intake start failed: ${err instanceof Error ? err.message : String(err)}`);
    return fail(502, "Could not start the call");
  }

  await started(false);
  return ok({
    conversation_token: session.conversation_token,
    agent_id: session.agent_id,
    dynamic_variables: {
      // Required by the published CareThread intake agent (docs/elevenlabs-agent.md).
      parent_name: caseRow.parent_alias,
      child_name: caseRow.child_alias,
      centre_name: DEMO_CENTRE_NAME,
      case_id: caseRow.id,
      // Used by our completion/webhook processing to find the case (010).
      intake_token: token,
      child_alias: caseRow.child_alias,
      parent_alias: caseRow.parent_alias,
      therapist_name: caseRow.therapist_name,
      language,
    },
  });
}
