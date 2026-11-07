import { z } from "zod";
import { audit } from "@/lib/audit";
import { isDemoMode } from "@/lib/demo";
import { getConversationToken } from "@/lib/elevenlabs/agent";
import { env } from "@/lib/env";
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

  let conversationToken: string;
  try {
    conversationToken = await getConversationToken();
  } catch (err) {
    console.error(`intake start failed: ${err instanceof Error ? err.message : String(err)}`);
    return fail(502, "Could not start the call");
  }

  await started(false);
  return ok({
    conversation_token: conversationToken,
    agent_id: env.ELEVENLABS_AGENT_ID,
    dynamic_variables: {
      intake_token: token,
      child_alias: caseRow.child_alias,
      parent_alias: caseRow.parent_alias,
      therapist_name: caseRow.therapist_name,
      language,
    },
  });
}
