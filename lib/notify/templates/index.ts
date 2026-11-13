// Template registry (FR-3): one file per template under lib/notify/templates/, each with en/hi/te strings.
import type { Template } from "../types";
import assessment_assigned from "./assessment_assigned";
import assessment_red_flag from "./assessment_red_flag";
import assessment_submitted from "./assessment_submitted";
import document_shared from "./document_shared";
import home_program_published from "./home_program_published";
import iep_published from "./iep_published";
import message_created from "./message_created";
import prescription_signed from "./prescription_signed";
import prescription_voided from "./prescription_voided";
import provider_claimed from "./provider_claimed";
import provider_rejected from "./provider_rejected";
import provider_suspended from "./provider_suspended";
import privacy_deletion_completed from "./privacy_deletion_completed";
import privacy_deletion_rejected from "./privacy_deletion_rejected";
import privacy_deletion_requested from "./privacy_deletion_requested";
import privacy_export_ready from "./privacy_export_ready";
import provider_verified from "./provider_verified";
import sharing_granted from "./sharing_granted";
import test_ping from "./test_ping";

export const TEMPLATES = {
  test_ping,
  message_created,
  document_shared,
  iep_published,
  home_program_published,
  assessment_assigned,
  assessment_red_flag,
  assessment_submitted,
  sharing_granted,
  provider_verified,
  provider_rejected,
  provider_suspended,
  provider_claimed,
  privacy_export_ready,
  privacy_deletion_requested,
  privacy_deletion_completed,
  privacy_deletion_rejected,
  prescription_signed,
  prescription_voided,
} as const satisfies Record<string, Template<never>>;

export type TemplateName = keyof typeof TEMPLATES;

export function getTemplate(name: string): Template | null {
  return (TEMPLATES as Record<string, Template>)[name] ?? null;
}
