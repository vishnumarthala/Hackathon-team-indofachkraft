// Template registry (FR-3): one file per template under lib/notify/templates/, each with en/hi/te strings.
import type { Template } from "../types";
import appointment_cancelled from "./appointment_cancelled";
import appointment_confirmed from "./appointment_confirmed";
import appointment_intake_link from "./appointment_intake_link";
import appointment_meet_failed from "./appointment_meet_failed";
import appointment_meet_ready from "./appointment_meet_ready";
import appointment_reminder_24h from "./appointment_reminder_24h";
import appointment_reminder_2h from "./appointment_reminder_2h";
import appointment_rescheduled from "./appointment_rescheduled";
import assessment_assigned from "./assessment_assigned";
import assessment_red_flag from "./assessment_red_flag";
import assessment_submitted from "./assessment_submitted";
import document_shared from "./document_shared";
import google_calendar_reconnect from "./google_calendar_reconnect";
import home_program_published from "./home_program_published";
import iep_published from "./iep_published";
import message_created from "./message_created";
import prescription_signed from "./prescription_signed";
import prescription_voided from "./prescription_voided";
import payment_refunded from "./payment_refunded";
import provider_claimed from "./provider_claimed";
import provider_rejected from "./provider_rejected";
import provider_suspended from "./provider_suspended";
import privacy_deletion_completed from "./privacy_deletion_completed";
import privacy_deletion_rejected from "./privacy_deletion_rejected";
import privacy_deletion_requested from "./privacy_deletion_requested";
import privacy_export_ready from "./privacy_export_ready";
import provider_verified from "./provider_verified";
import rating_prompt from "./rating_prompt";
import series_changed from "./series_changed";
import series_created from "./series_created";
import sharing_granted from "./sharing_granted";
import test_ping from "./test_ping";
import voice_budget_alert from "./voice_budget_alert";

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
  appointment_confirmed,
  appointment_reminder_24h,
  appointment_reminder_2h,
  appointment_cancelled,
  appointment_rescheduled,
  appointment_intake_link,
  appointment_meet_ready,
  appointment_meet_failed,
  google_calendar_reconnect,
  payment_refunded,
  rating_prompt,
  voice_budget_alert,
  series_created,
  series_changed,
} as const satisfies Record<string, Template<never>>;

export type TemplateName = keyof typeof TEMPLATES;

export function getTemplate(name: string): Template | null {
  return (TEMPLATES as Record<string, Template>)[name] ?? null;
}
