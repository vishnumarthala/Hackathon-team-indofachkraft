// 015: client-safe email status values and labels (shared by the route, page and ParentVoiceNote).
export type EmailStatus = "sent" | "demo" | "no_email" | "failed";

export const EMAIL_STATUS_TEXT: Record<EmailStatus, string> = {
  sent: "Email sent to parent",
  demo: "Email not sent (demo mode)",
  no_email: "No parent email on the case",
  failed: "Email could not be sent",
};

export function isEmailStatus(value: unknown): value is EmailStatus {
  return value === "sent" || value === "demo" || value === "no_email" || value === "failed";
}
