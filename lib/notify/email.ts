// FR-6 email channel: wraps lib/email.ts (DEMO_MODE behaviour kept: nothing leaves the machine and the row is
// `sent` with provider id `demo`). Adds the optional `.ics` invite and the Resend idempotency key.
import { EmailError, sendEmail, type SendEmailInput } from "@/lib/email";
import { env } from "@/lib/env";
import { buildIcs } from "./ics";
import { NotifyError, type EmailContent, type SendOutcome } from "./types";

export type EmailJob = {
  notificationId: string;
  to: string | null;
  /** The recipient's `email` preference (default on). */
  enabled: boolean;
  content: EmailContent | undefined;
  /** Stable calendar UID and SEQUENCE for the event's aggregate (only used when the template adds an invite). */
  ics?: { uid: string; sequence: number };
};

export type EmailDeps = { send: (input: SendEmailInput) => Promise<{ id: string; delivered: boolean }> };

// 019: phone-only demo accounts get a hidden `...@phone.demo.doctornearme.invalid` login address.
export function isDeliverableAddress(address: string | null | undefined): address is string {
  if (!address) return false;
  const domain = address.split("@")[1]?.toLowerCase() ?? "";
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) && !domain.endsWith(".invalid") && domain !== "invalid";
}

function emailOf(from: string): string | null {
  return /<([^>]+)>/.exec(from)?.[1] ?? (from.includes("@") ? from.trim() : null);
}

export function idempotencyKey(notificationId: string): string {
  return `notification:${notificationId}`;
}

// Resend: 400/422 (invalid address, validation) and 403 (sender/recipient not allowed) will not succeed on retry.
const PERMANENT_STATUS = new Set([400, 403, 422]);

export async function deliverEmail(job: EmailJob, deps: EmailDeps = { send: (input) => sendEmail(input) }): Promise<SendOutcome> {
  if (!job.enabled) return { status: "skipped", reason: "opted_out" };
  if (!isDeliverableAddress(job.to)) return { status: "skipped", reason: "no_email" };
  if (!job.content) return { status: "skipped", reason: "no_content" };

  const { ics, ...content } = job.content;
  const attachments = ics
    ? [
        {
          filename: "invite.ics",
          content: Buffer.from(
            buildIcs(ics, {
              uid: job.ics?.uid ?? `notification-${job.notificationId}@doctornearme`,
              sequence: job.ics?.sequence ?? 0,
              organizer: emailOf(env.EMAIL_FROM),
              attendee: job.to,
            }),
            "utf8",
          ).toString("base64"),
          contentType: `text/calendar; method=${ics.method}; charset=UTF-8`,
        },
      ]
    : undefined;

  try {
    const result = await deps.send({
      to: job.to,
      subject: content.subject,
      text: content.text,
      html: content.html,
      ...(attachments ? { attachments } : {}),
      idempotencyKey: idempotencyKey(job.notificationId),
    });
    return { status: "sent", providerMessageId: result.id };
  } catch (err) {
    if (err instanceof EmailError) {
      const permanent = err.statusCode !== undefined && PERMANENT_STATUS.has(err.statusCode);
      throw new NotifyError(`email_${err.code ?? err.statusCode ?? "error"}`, permanent, err.message);
    }
    throw new NotifyError("email_error", false, err instanceof Error ? err.message : String(err));
  }
}
