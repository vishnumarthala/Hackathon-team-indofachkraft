import { Resend } from "resend";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";

export class EmailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmailError";
  }
}

type SendPayload = { from: string; to: string; subject: string; text: string; html?: string };

export type EmailClient = {
  emails: {
    send(payload: SendPayload): Promise<{ data: { id: string } | null; error: { message: string } | null }>;
  };
};

export type SendEmailInput = { to: string; subject: string; text: string; html?: string; caseId?: string | null };

export async function sendEmail(
  input: SendEmailInput,
  client?: EmailClient,
): Promise<{ id: string; delivered: boolean }> {
  if (env.DEMO_MODE) {
    await audit({
      caseId: input.caseId ?? null,
      actor: "system",
      action: "email.demo_skipped",
      entity: "email",
      details: { to: input.to, subject: input.subject },
    });
    return { id: "demo", delivered: false };
  }

  const redirect = env.DEMO_EMAIL_TO;
  const payload: SendPayload = {
    from: env.EMAIL_FROM,
    to: redirect ?? input.to,
    subject: input.subject,
    text: redirect ? `Originally to: ${input.to}\n\n${input.text}` : input.text,
    ...(input.html ? { html: input.html } : {}),
  };

  const resend = client ?? (new Resend(env.RESEND_API_KEY) as unknown as EmailClient);
  let result: Awaited<ReturnType<EmailClient["emails"]["send"]>>;
  try {
    result = await resend.emails.send(payload);
  } catch (err) {
    throw new EmailError(`Email could not be sent: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (result.error || !result.data) {
    throw new EmailError(`Email could not be sent: ${result.error?.message ?? "no response"}`);
  }
  return { id: result.data.id, delivered: true };
}
