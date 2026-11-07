import type { CaseRow } from "@/lib/types";

type MessageCase = Pick<CaseRow, "parent_alias" | "therapist_name" | "child_alias">;

export function intakeUrl(appUrl: string, token: string): string {
  return `${appUrl.replace(/\/+$/, "")}/intake/${token}`;
}

export function intakeMessage(c: MessageCase, url: string): string {
  return (
    `Hello ${c.parent_alias}, this is ${c.therapist_name}'s team at CareThread. ` +
    `Before ${c.child_alias}'s first session, please take a short voice call (about 15 minutes) ` +
    `with our AI assistant in Telugu, Hindi or English: ${url}`
  );
}

export function whatsappUrl(phone: string | null | undefined, message: string): string {
  const digits = (phone ?? "").replace(/\D/g, "");
  return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
}

export function intakeEmailSubject(childAlias: string): string {
  return `Your CareThread intake call for ${childAlias}`;
}

export type IntakeShare = { url: string; message: string; whatsapp_url: string };

export function buildIntakeShare(
  c: MessageCase & Pick<CaseRow, "parent_phone">,
  appUrl: string,
  token: string,
): IntakeShare {
  const url = intakeUrl(appUrl, token);
  const message = intakeMessage(c, url);
  return { url, message, whatsapp_url: whatsappUrl(c.parent_phone, message) };
}
