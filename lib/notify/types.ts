// Shared notification types (ticket 032). Server-only modules import these; nothing here touches the network.
import type { UserRole } from "@/lib/auth";
import type { Locale } from "@/lib/i18n/config";

export const CHANNELS = ["in_app", "email", "whatsapp"] as const;
export type Channel = (typeof CHANNELS)[number];

/** Channels a user can switch off (FR-8). In-app cannot be disabled. */
export const OPTIONAL_CHANNELS = ["email", "whatsapp"] as const;
export type OptionalChannel = (typeof OPTIONAL_CHANNELS)[number];

export const NOTIFICATION_STATUSES = ["pending", "sending", "sent", "failed", "dead", "skipped", "cancelled"] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

/** A calendar invite attached to an email as `invite.ics` (030 appointment events). */
export type IcsInvite = {
  method: "REQUEST" | "CANCEL";
  start: string;
  end: string;
  summary: string;
  description?: string;
  location?: string;
  url?: string;
};

export type EmailContent = { subject: string; text: string; html: string; ics?: IcsInvite };
export type WhatsAppContent = { name: string; language: string; params: string[] };

/** What a template produces. `link` is always an app path (the signed-in page), never an external URL. */
export type Rendered = {
  title: string;
  body: string;
  link: string;
  email?: EmailContent;
  whatsapp?: WhatsAppContent;
};

export type OutboxEventRow = {
  id: string;
  topic: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: Record<string, unknown>;
  dedup_key: string;
  deliver_after: Date;
  status: "pending" | "fanned_out" | "cancelled";
  created_at: Date;
};

export type TemplateContext<P = Record<string, unknown>> = {
  payload: P;
  locale: Locale;
  /** The recipient's role: the same event links guardians and providers to different pages. */
  role: UserRole;
  /** Absolute base URL for email/WhatsApp links (NEXT_PUBLIC_APP_URL). */
  appUrl: string;
  event: Pick<OutboxEventRow, "id" | "aggregate_type" | "aggregate_id">;
};

export type Template<P = Record<string, unknown>> = {
  name: string;
  render(ctx: TemplateContext<P>): Rendered;
};

/** Result of one email/WhatsApp delivery attempt. Errors are thrown as NotifyError instead. */
export type SendOutcome =
  | { status: "sent"; providerMessageId: string | null }
  | { status: "skipped"; reason: SkipReason };

export type SkipReason = "opted_out" | "no_email" | "no_phone" | "whatsapp_not_configured" | "no_content";

/** A delivery failure. `permanent` (invalid address, template rejected, provider-side opt-out) -> `dead` at once. */
export class NotifyError extends Error {
  constructor(
    readonly code: string,
    readonly permanent: boolean,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "NotifyError";
  }
}
