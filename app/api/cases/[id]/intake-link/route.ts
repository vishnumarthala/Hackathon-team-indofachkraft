import { z } from "zod";
import { audit } from "@/lib/audit";
import { requireCaseAccess } from "@/lib/authz";
import { requireCaseConsent } from "@/lib/consent";
import { sendEmail } from "@/lib/email";
import { env } from "@/lib/env";
import { fail, ok } from "@/lib/http";
import { buildIntakeShare, intakeEmailSubject } from "@/lib/intake/message";
import { getCase } from "@/lib/queries/cases";
import { ensureIntakeToken, revokeIntakeToken } from "@/lib/queries/intake";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({ send_email: z.boolean().optional() });

async function readBody(req: Request): Promise<z.infer<typeof bodySchema> | null> {
  const raw = await req.text();
  if (raw.trim() === "") return {};
  try {
    const parsed = bodySchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const denied = await requireCaseAccess(id);
  if (denied) return denied;
  const caseRow = await getCase(id);
  if (!caseRow) return fail(404, "Case not found");
  // 020 FR-7: no intake link without the guardian's ai_intake_call consent.
  const blocked = await requireCaseConsent(id, "ai_intake_call");
  if (blocked) return blocked;

  const body = await readBody(req);
  if (!body) return fail(400, "Invalid request", { send_email: "Must be true or false" });
  if (body.send_email && !caseRow.parent_email) return fail(422, "Add a parent email first");

  let token: string;
  let created: boolean;
  try {
    ({ token, created } = await ensureIntakeToken(caseRow));
  } catch {
    return fail(500, "Could not create the intake link");
  }
  const share = buildIntakeShare(caseRow, env.NEXT_PUBLIC_APP_URL, token);
  if (created) {
    await audit({ caseId: id, action: "intake.link_created", entity: "case", entityId: id });
  }

  if (!body.send_email || !caseRow.parent_email) {
    return ok({ url: share.url, whatsapp_url: share.whatsapp_url, emailed: false });
  }

  try {
    const result = await sendEmail({
      to: caseRow.parent_email,
      subject: intakeEmailSubject(caseRow.child_alias),
      text: share.message,
      caseId: id,
    });
    await audit({
      caseId: id,
      action: "intake.link_emailed",
      entity: "case",
      entityId: id,
      details: { delivered: result.delivered },
    });
    return ok({ url: share.url, whatsapp_url: share.whatsapp_url, emailed: result.delivered });
  } catch (err) {
    console.error(`intake email failed: ${err instanceof Error ? err.message : String(err)}`);
    return ok({ url: share.url, whatsapp_url: share.whatsapp_url, emailed: false, email_error: "Email could not be sent" });
  }
}

// 020 FR-10: revoke the open intake link; creating a link again issues a new token.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const denied = await requireCaseAccess(id);
  if (denied) return denied;
  let revoked: boolean;
  try {
    revoked = await revokeIntakeToken(id);
  } catch {
    return fail(500, "Could not revoke the intake link");
  }
  if (revoked) {
    await audit({ caseId: id, action: "intake.link_revoked", entity: "case", entityId: id });
  }
  return ok({ revoked: true });
}
