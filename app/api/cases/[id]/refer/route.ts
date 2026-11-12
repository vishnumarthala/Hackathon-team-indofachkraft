import { audit } from "@/lib/audit";
import { requireApiUser } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/db";
import { sendEmail } from "@/lib/email";
import { generateJson } from "@/lib/gemini";
import { fail, ok, parseJson } from "@/lib/http";
import { getReferralContext, specialistUrl } from "@/lib/queries/referrals";
import {
  assessReferral,
  buildPacket,
  buildSummaryPrompt,
  referralSystemPrompt,
  ReferRequestSchema,
} from "@/lib/referral/packet";
import { newToken } from "@/lib/tokens";
import { ReferralSummarySchema, type ReferralSummary } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type EmailStatus = "sent" | "demo" | "failed";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const unauthorized = await requireApiUser();
  if (unauthorized) return unauthorized;

  const { id } = await params;

  const parsed = await parseJson(req, ReferRequestSchema);
  if ("response" in parsed) return parsed.response;
  const body = parsed.data;

  const context = await getReferralContext(id);
  if (!context) return fail(404, "Case not found");
  const { caseRow, session, brief, intakeFlags } = context;

  const assessment = assessReferral({
    isaaFacts: context.isaaFacts,
    facpScore: caseRow.facp_score,
    brief,
    intakeFlags,
  });
  if (!session || assessment.decided.length === 0) {
    return fail(422, "Confirm at least one ISAA item before referring");
  }

  let summary: ReferralSummary;
  try {
    summary = await generateJson({
      task: "referral",
      system: referralSystemPrompt(),
      prompt: buildSummaryPrompt({ caseRow, assessment, brief, reason: body.reason }),
      schema: ReferralSummarySchema,
    });
  } catch (err) {
    console.error(`referral summary failed: ${err instanceof Error ? err.message : String(err)}`);
    return fail(502, "Referral could not be prepared");
  }

  const packet = buildPacket({
    caseRow,
    session,
    isaaFacts: context.isaaFacts,
    brief,
    intakeFlags,
    summary,
    generatedAt: new Date().toISOString(),
  });

  const db = supabaseAdmin();
  const shareToken = newToken();
  const { data: inserted, error: insertError } = await db
    .from("referrals")
    .insert({
      case_id: caseRow.id,
      share_token: shareToken,
      specialist_name: body.specialist_name,
      specialist_email: body.specialist_email,
      reason: body.reason,
      packet,
      parent_consent: true,
      status: "sent",
      emailed: false,
    })
    .select("id")
    .single();
  if (insertError || !inserted) return fail(500, "Could not save the referral");
  const referralId = (inserted as { id: string }).id;
  const url = specialistUrl(shareToken);

  let emailStatus: EmailStatus;
  try {
    const result = await sendEmail({
      to: body.specialist_email,
      subject: `Referral: ${caseRow.child_alias} (DoctorNearMe)`,
      text: [
        `Hello ${body.specialist_name},`,
        "",
        `${caseRow.therapist_name} has shared a referral for ${caseRow.child_alias} with you through DoctorNearMe.`,
        "",
        `Reason for referral: ${body.reason}`,
        "",
        `Open the referral packet: ${url}`,
        "",
        "This private link shows the confirmed observations and lets you play the recorded moments behind them.",
        "AI documents, the clinician decides. This is not a diagnosis by AI.",
      ].join("\n"),
      caseId: caseRow.id,
    });
    emailStatus = result.delivered ? "sent" : "demo";
  } catch (err) {
    console.error(`referral email failed: ${err instanceof Error ? err.message : String(err)}`);
    emailStatus = "failed";
  }
  const emailed = emailStatus === "sent";

  if (emailed) {
    const { error } = await db.from("referrals").update({ emailed: true }).eq("id", referralId);
    if (error) console.error(`could not store emailed flag: ${error.message}`);
  }
  const { error: caseError } = await db.from("cases").update({ status: "referred" }).eq("id", caseRow.id);
  if (caseError) console.error(`could not update case status: ${caseError.message}`);

  await audit({
    caseId: caseRow.id,
    actor: "therapist",
    action: "referral.created",
    entity: "referral",
    entityId: referralId,
    details: {
      session_id: session.id,
      session_number: session.session_number,
      confirmed_items: assessment.decided.length,
      key_evidence: packet.key_evidence.length,
      emailed,
      email_status: emailStatus,
    },
  });

  return ok({ referral_id: referralId, url, emailed, email_status: emailStatus }, 201);
}
