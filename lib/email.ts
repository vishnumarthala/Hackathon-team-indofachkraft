import { Resend } from "resend";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";

export class EmailError extends Error {
  constructor(
    message: string,
    // 032: provider status/name (e.g. 422 `validation_error`) so the outbox can tell permanent from transient.
    readonly statusCode?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "EmailError";
  }
}

/** `content` is base64 (what the Resend API expects for string content). */
export type EmailAttachment = { filename: string; content: string; contentType: string };

type SendPayload = {
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  attachments?: EmailAttachment[];
};

type SendError = { message: string; statusCode?: number | null; name?: string };

export type EmailClient = {
  emails: {
    send(
      payload: SendPayload,
      options?: { idempotencyKey?: string },
    ): Promise<{ data: { id: string } | null; error: SendError | null }>;
  };
};

export type SendEmailInput = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  caseId?: string | null;
  /** 032: e.g. a calendar invite (`text/calendar`). */
  attachments?: EmailAttachment[];
  /** 032: Resend `Idempotency-Key` (e.g. `notification:<id>`), so a retried send is delivered once. */
  idempotencyKey?: string;
};

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
    ...(input.attachments?.length ? { attachments: input.attachments } : {}),
  };

  const resend = client ?? (new Resend(env.RESEND_API_KEY) as unknown as EmailClient);
  let result: Awaited<ReturnType<EmailClient["emails"]["send"]>>;
  try {
    result = input.idempotencyKey
      ? await resend.emails.send(payload, { idempotencyKey: input.idempotencyKey })
      : await resend.emails.send(payload);
  } catch (err) {
    throw new EmailError(`Email could not be sent: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (result.error || !result.data) {
    throw new EmailError(
      `Email could not be sent: ${result.error?.message ?? "no response"}`,
      result.error?.statusCode ?? undefined,
      result.error?.name,
    );
  }
  return { id: result.data.id, delivered: true };
}
