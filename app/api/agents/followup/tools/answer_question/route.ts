import { handleAnswerTool } from "@/lib/followup/tool";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Ticket 040 FR-5: ElevenLabs server tool `answer_question` of the `DoctorNearMe Follow-up` agent. Public in
// lib/auth-access.ts; authenticated by `X-Agent-Secret` and the 15-minute `followup_session` in the body, which is
// bound to one (guardian, child) (lib/followup/tool.ts).
export async function POST(req: Request) {
  return handleAnswerTool(req, { kind: "secret" });
}
